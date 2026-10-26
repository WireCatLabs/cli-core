import { CliError, errorObjectOf, type FailureContext, isCliError, mcpErrorResult } from "@wirecat/cli-base"
import { meetingHitsList } from "../answers.js"
import { type MeetingHitSearch, validateMeetingHitSearch } from "../search-validation.js"
import { agentResult, UNTRUSTED_NEUTRAL } from "./agent-text.js"

const integer = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const name = { type: "string", minLength: 1, maxLength: 200 }
export const meetingSearchTool = {
  name: "search_meetings",
  description: `Find words in the selected account's stored meetings, indexing new ones first; participant filters do not say who spoke a hit. ${UNTRUSTED_NEUTRAL}`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        minLength: 1,
        description:
          'The messages query language: words (all required), OR, (groups), NOT or -word, "a phrase", "a b"~N for words within N transcript lines (at most 20), exact:word, from:"Name" for who said the line',
      },
      meeting_id: integer,
      identity_id: integer,
      person_id: integer,
      event_id: integer,
      series_id: integer,
      project: name,
      tag: name,
      topic: name,
      since_time: { type: "integer", minimum: -8640000000000000, maximum: 8640000000000000 },
      until_time: { type: "integer", minimum: -8640000000000000, maximum: 8640000000000000 },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
      cursor: { type: "string", minLength: 1, maxLength: 1000 },
      max_read_bytes: { type: "integer", minimum: 1, maximum: 67108864 },
    },
    required: ["query"],
    additionalProperties: false,
  },
}
export const callMeetingSearchTool = async (
  search: MeetingHitSearch,
  input: unknown,
  signal?: AbortSignal,
  failure: FailureContext = {},
) => {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new CliError("validation_error", "expected search argument object")
    const args = input as Record<string, unknown>
    if (Object.keys(args).some((key) => !Object.hasOwn(meetingSearchTool.inputSchema.properties, key)))
      throw new CliError("validation_error", "unknown meeting search argument")
    const options = {
      meetingId: args.meeting_id as number | undefined,
      participantIdentityId: args.identity_id as number | undefined,
      personId: args.person_id as number | undefined,
      eventId: args.event_id as number | undefined,
      meetingSeriesId: args.series_id as number | undefined,
      project: args.project as string | undefined,
      tag: args.tag as string | undefined,
      topic: args.topic as string | undefined,
      since: args.since_time as number | undefined,
      until: args.until_time as number | undefined,
      limit: args.limit as number | undefined,
      after: args.cursor as string | undefined,
      maxReadBytes: args.max_read_bytes as number | undefined,
      signal,
    }
    const query = args.query as string
    validateMeetingHitSearch(query, options)
    signal?.throwIfAborted()
    const window = {
      ...(options.since === undefined ? {} : { since: new Date(options.since).toISOString() }),
      ...(options.until === undefined ? {} : { until: new Date(options.until).toISOString() }),
    }
    const result = meetingHitsList(
      await search(query, options),
      options.limit ?? 100,
      "search meetings",
      { ...args, max_read_bytes: options.maxReadBytes ?? 4194304 },
      Object.keys(window).length === 0 ? {} : { window },
    )
    signal?.throwIfAborted()
    return agentResult({
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    })
  } catch (error) {
    const thrown =
      !isCliError(error) && signal?.aborted ? new CliError("cancelled", "meeting search was cancelled") : error
    return agentResult(
      mcpErrorResult(errorObjectOf(thrown, { ...failure, effects: { remote: "none", local: "read" } })),
    )
  }
}
