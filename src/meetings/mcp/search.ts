import { CliError } from "@wirecat/cli-base"
import { type MeetingHitSearch, validateMeetingHitSearch } from "../search-validation.js"

const integer = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const name = { type: "string", minLength: 1, maxLength: 200 }
export const meetingHitSearchTool = {
  name: "meeting_search_page",
  description:
    "Bounded selected-account meeting keyword search with explicit participant/person, project and label filters; participant filters do not attribute speech",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", minLength: 1 },
      meeting_id: integer,
      identity_id: integer,
      person_id: integer,
      project: name,
      tag: name,
      topic: name,
      since: { type: "integer", minimum: -8640000000000000, maximum: 8640000000000000 },
      until: { type: "integer", minimum: -8640000000000000, maximum: 8640000000000000 },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
      after: { type: "string", minLength: 1, maxLength: 1000 },
      max_read_bytes: { type: "integer", minimum: 1, maximum: 67108864 },
    },
    required: ["query"],
    additionalProperties: false,
  },
}
export const callMeetingHitSearchTool = async (search: MeetingHitSearch, input: unknown, signal?: AbortSignal) => {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new CliError("validation_error", "expected search argument object")
    const args = input as Record<string, unknown>
    if (Object.keys(args).some((key) => !Object.hasOwn(meetingHitSearchTool.inputSchema.properties, key)))
      throw new CliError("validation_error", "unknown meeting search argument")
    const options = {
      meetingId: args.meeting_id as number | undefined,
      participantIdentityId: args.identity_id as number | undefined,
      personId: args.person_id as number | undefined,
      project: args.project as string | undefined,
      tag: args.tag as string | undefined,
      topic: args.topic as string | undefined,
      since: args.since as number | undefined,
      until: args.until as number | undefined,
      limit: args.limit as number | undefined,
      after: args.after as string | undefined,
      maxReadBytes: args.max_read_bytes as number | undefined,
      signal,
    }
    const query = args.query as string
    validateMeetingHitSearch(query, options)
    signal?.throwIfAborted()
    const result = await search(query, options)
    signal?.throwIfAborted()
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result }
  } catch (error) {
    const result = {
      error: {
        code: error instanceof CliError ? error.code : signal?.aborted ? "cancelled" : "generic_failure",
        message:
          error instanceof CliError
            ? error.message
            : signal?.aborted
              ? "Meeting search was cancelled"
              : "Meeting search failed",
      },
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
      isError: true,
    }
  }
}
