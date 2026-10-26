import { CliError, errorObjectOf, type FailureContext, isCliError, mcpErrorResult } from "@wirecat/cli-base"
import { errorObjectSchema, itemEnvelopeSchema, jsonSchemaOf } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import {
  boundMeetingSeriesInventoryItem,
  type MeetingSeriesInventoryReader,
  meetingSeriesInventoryInput,
  readMeetingSeriesInventory,
} from "../cli/meeting-series-inventory-read.js"
import { meetingSeriesInventory } from "../entities/index.js"
import { agentBody, agentResult, UNTRUSTED_NEUTRAL } from "./text.js"

const inputSchema: Record<string, unknown> = { ...jsonSchemaOf(meetingSeriesInventoryInput) }
const outputSchema: Record<string, unknown> = {
  ...jsonSchemaOf(v.union([itemEnvelopeSchema(meetingSeriesInventory), errorObjectSchema])),
}
export const meetingSeriesInventoryTool = {
  name: "meeting_series_inventory",
  description: `Discover one bounded page of series candidates in the host's selected provider/account. ISO after/until default to now and seven days ahead. Provider inventory may contain undated or past recurring start hints; these never prove the next occurrence or calendar completeness. Continue with page.next_cursor and the returned absolute after/until. No store writes or automatic selection. ${UNTRUSTED_NEUTRAL}`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { ...inputSchema, type: "object" as const },
  outputSchema: { ...outputSchema, type: "object" as const },
}
export const callMeetingSeriesInventoryTool = async (
  read: MeetingSeriesInventoryReader,
  input: unknown,
  signal?: AbortSignal,
  failure: FailureContext = {},
  now?: number,
) => {
  try {
    const result = agentBody(await readMeetingSeriesInventory(read, input, signal, now))
    boundMeetingSeriesInventoryItem(result.item)
    return agentResult({
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    })
  } catch (error) {
    const cause =
      !isCliError(error) && signal?.aborted
        ? new CliError("cancelled", "meeting inventory reading was cancelled")
        : error
    return agentResult(mcpErrorResult(errorObjectOf(cause, { ...failure, effects: { remote: "read", local: "read" } })))
  }
}
