import { errorObjectOf, type FailureContext, mcpErrorResult } from "@wirecat/cli-base"
import { errorObjectSchema, itemEnvelopeSchema, jsonSchemaOf } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { REMOTE_READ } from "../cli/effects.js"
import {
  type MeetingPreparationReader,
  meetingPreparationInput,
  readMeetingPreparation,
} from "../cli/meeting-preparation-read.js"
import { meetingPreparation } from "../entities/index.js"

const inputSchema: Record<string, unknown> = { ...jsonSchemaOf(meetingPreparationInput) }
const outputSchema: Record<string, unknown> = {
  ...jsonSchemaOf(v.union([itemEnvelopeSchema(meetingPreparation), errorObjectSchema])),
}
export const meetingPreparationTool = {
  name: "meeting_prepare",
  description:
    "Prepare cited context for one exact provider series in the server's selected account. Reads remote upcoming proof and bounded stored history, people/project links, accepted meeting facts and directly sourced tasks; performs no writes. Optional ISO windows default to now, seven days ahead and thirty days of history. Coverage identifies incomplete and unqueried context.",
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
    const result = await readMeetingPreparation(read, input, signal, now)
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result }
  } catch (error) {
    return mcpErrorResult(errorObjectOf(error, { ...failure, effects: REMOTE_READ }))
  }
}
