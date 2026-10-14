import { CliError, errorObjectOf, type FailureContext, isCliError, mcpErrorResult } from "@wirecat/cli-base"
import type { MeetingProjectDiscoveryReader } from "../project-discovery.js"
import { readMeetingProjectEvidence } from "../project-evidence.js"

export const meetingProjectEvidenceTool = {
  name: "meeting_project_evidence",
  description:
    "Read one bounded page of cited project-name/key/alias evidence from the selected account's local meeting index. Does not refresh indexes or confirm project membership. Query takes exact meeting_id, identity_id, person_id, tag_id, event_id, series_id and UTC started_at terms joined by AND. Resume with next's frozen query even when hits are empty; archive/index completeness remains unknown.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: "object" as const,
    properties: {
      project: { type: "string", minLength: 1, maxLength: 200 },
      query: { type: "string", maxLength: 8192 },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
      cursor: { type: "string", minLength: 1, maxLength: 4096 },
      max_read_bytes: { type: "integer", minimum: 1, maximum: 67108864 },
    },
    required: ["project"],
    additionalProperties: false,
  },
}
export const callMeetingProjectEvidenceTool = async (
  read: MeetingProjectDiscoveryReader,
  input: unknown,
  signal?: AbortSignal,
  failure: FailureContext = {},
  now?: number,
) => {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new CliError("validation_error", "expected project evidence arguments")
    const args = input as Record<string, unknown>
    if (Object.keys(args).some((key) => !Object.hasOwn(meetingProjectEvidenceTool.inputSchema.properties, key)))
      throw new CliError("validation_error", "unknown project evidence argument")
    const result = await readMeetingProjectEvidence(
      read,
      args.project as string,
      {
        query: args.query as string | undefined,
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
        maxReadBytes: args.max_read_bytes as number | undefined,
        signal,
      },
      now,
    )
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result }
  } catch (error) {
    const cause =
      !isCliError(error) && signal?.aborted ? new CliError("cancelled", "project evidence read was cancelled") : error
    return mcpErrorResult(errorObjectOf(cause, failure))
  }
}
