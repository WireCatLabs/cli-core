import { errorObjectOf, type FailureContext, mcpErrorResult } from "@wirecat/cli-base"
import { errorObjectSchema, itemEnvelopeSchema, jsonSchemaOf } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { REMOTE_READ } from "../cli/effects.js"
import { boundMeetingPreparationItem } from "../cli/meeting-preparation-budget.js"
import {
  type MeetingPreparationReader,
  meetingPreparationInput,
  readMeetingPreparation,
} from "../cli/meeting-preparation-read.js"
import { meetingPreparation } from "../entities/index.js"
import { agentBody, agentResult, UNTRUSTED } from "./text.js"

const inputSchema: Record<string, unknown> = { ...jsonSchemaOf(meetingPreparationInput) }
const outputSchema: Record<string, unknown> = {
  ...jsonSchemaOf(v.union([itemEnvelopeSchema(meetingPreparation), errorObjectSchema])),
}
export const meetingPreparationTool = {
  name: "meeting_prepare",
  description: `Prepare cited context for one exact provider series in the server's selected account. Reads remote upcoming proof and bounded stored history, related meeting transcripts through explicit people/confirmed project links, accepted meeting facts and directly sourced tasks; performs no writes. Optional ISO windows default to now, seven days ahead and thirty days of history. Coverage identifies incomplete and unqueried context. ${UNTRUSTED}`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { ...inputSchema, type: "object" as const },
  outputSchema: { ...outputSchema, type: "object" as const },
}
export const callMeetingPreparationTool = async (
  read: MeetingPreparationReader,
  input: unknown,
  signal?: AbortSignal,
  failure: FailureContext = {},
  now?: number,
) => {
  try {
    const result = agentBody(await readMeetingPreparation(read, input, signal, now))
    boundMeetingPreparationItem(result.item)
    if (result.item.coverage.output_limited) result.meta = { ...result.meta, truncated: true }
    return agentResult({
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    })
  } catch (error) {
    return agentResult(mcpErrorResult(errorObjectOf(error, { ...failure, effects: REMOTE_READ })))
  }
}
