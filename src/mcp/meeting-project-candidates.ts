import { CliError, errorObjectOf, type FailureContext, isCliError, mcpErrorResult } from "@wirecat/cli-base"
import { errorObjectSchema, itemEnvelopeSchema, jsonSchemaOf } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { boundMeetingProjectCandidatesItem } from "../cli/meeting-project-candidates-budget.js"
import { meetingProjectCandidatesInput, readMeetingProjectCandidates } from "../cli/meeting-project-candidates-read.js"
import { meetingProjectCandidates } from "../entities/index.js"
import type { StoredMeetingProjectCandidateReader } from "../services/index.js"
import { agentBody, agentResult, UNTRUSTED_NEUTRAL } from "./text.js"

const inputSchema: Record<string, unknown> = { ...jsonSchemaOf(meetingProjectCandidatesInput) }
const outputSchema: Record<string, unknown> = {
  ...jsonSchemaOf(v.union([itemEnvelopeSchema(meetingProjectCandidates), errorObjectSchema])),
}

export const meetingProjectCandidatesTool = {
  name: "meeting_project_candidates",
  description: `Suggest existing global projects from one selected local meeting's title and one bounded page of current transcript cues. Matches literal names, keys and aliases; returns citations, ambiguity, fingerprints and incomplete evidence coverage. Does not create projects, infer membership or save links. Resume with evidence.coverage.next_cursor and the same ref. ${UNTRUSTED_NEUTRAL}`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { ...inputSchema, type: "object" as const },
  outputSchema: { ...outputSchema, type: "object" as const },
}
export const callMeetingProjectCandidatesTool = async (
  read: StoredMeetingProjectCandidateReader,
  input: unknown,
  signal?: AbortSignal,
  failure: FailureContext = {},
) => {
  try {
    const result = agentBody(await readMeetingProjectCandidates(read, input, signal))
    boundMeetingProjectCandidatesItem(result.item)
    if (result.item.coverage.output_limited) result.meta = { ...result.meta, truncated: true }
    return agentResult({
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    })
  } catch (error) {
    const cause =
      !isCliError(error) && signal?.aborted
        ? new CliError("cancelled", "project candidate reading was cancelled")
        : error
    return agentResult(mcpErrorResult(errorObjectOf(cause, { ...failure, effects: { remote: "none", local: "read" } })))
  }
}
