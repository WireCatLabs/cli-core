import { CliError, errorObjectOf, type FailureContext, isCliError, mcpErrorResult } from "@wirecat/cli-base"
import {
  type MeetingPassageOutputFormat,
  type MeetingPassageReader,
  type MeetingPassageResult,
  markedPassage,
  validateMeetingPassage,
} from "../passage.js"
import { agentResult, UNTRUSTED_NEUTRAL } from "./agent-text.js"

const count = { type: "integer", minimum: 0, maximum: 999 }
export const meetingPassageTool = {
  name: "meeting_passage",
  description: `Read a retained cue with bounded surrounding context, citations, revision and explicit coverage; account is fixed by the host. ${UNTRUSTED_NEUTRAL}`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: "object" as const,
    properties: {
      reference: { type: "string", minLength: 1, maxLength: 200 },
      before: count,
      after: count,
      bytes: { type: "integer", minimum: 2, maximum: 4194304 },
      max_read_bytes: { type: "integer", minimum: 1, maximum: 67108864 },
      expected_fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
      format: { type: "string", enum: ["json", "text", "markdown"] },
    },
    required: ["reference"],
    additionalProperties: false,
  },
}
/**
 * `forRun` is how the host prints the passage in this run: `passageForRun` from `@wirecat/cli-core`, which marks
 * the cues in a scheduled agent's run. This module cannot read the run's mark.
 */
export const callMeetingPassageTool = async (
  read: MeetingPassageReader,
  input: unknown,
  signal?: AbortSignal,
  failure: FailureContext = {},
  forRun: (result: MeetingPassageResult, format: MeetingPassageOutputFormat) => MeetingPassageResult = (result) =>
    result,
) => {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new CliError("validation_error", "expected passage arguments")
    const args = input as Record<string, unknown>
    if (Object.keys(args).some((key) => !Object.hasOwn(meetingPassageTool.inputSchema.properties, key)))
      throw new CliError("validation_error", "unknown passage argument")
    const options = {
      before: args.before as number | undefined,
      after: args.after as number | undefined,
      bytes: args.bytes as number | undefined,
      max_read_bytes: args.max_read_bytes as number | undefined,
      expected_fingerprint: args.expected_fingerprint as string | undefined,
      format: (args.format ?? "json") as "json" | "text" | "markdown",
      signal,
    }
    const reference = args.reference as string
    validateMeetingPassage(reference, options)
    signal?.throwIfAborted()
    const result = forRun(markedPassage(await read(reference, options)), options.format)
    signal?.throwIfAborted()
    return agentResult({ content: [{ type: "text" as const, text: result.content }], structuredContent: result.packet })
  } catch (error) {
    const cause =
      !isCliError(error) && signal?.aborted ? new CliError("cancelled", "meeting passage was cancelled") : error
    return agentResult(mcpErrorResult(errorObjectOf(cause, { ...failure, effects: { remote: "none", local: "read" } })))
  }
}
