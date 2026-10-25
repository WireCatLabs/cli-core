import { CliError, errorObjectOf, type FailureContext, mcpErrorResult } from "@wirecat/cli-base"
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
import { agentBody, agentResult, UNTRUSTED_NEUTRAL } from "./text.js"

const outputSchema: Record<string, unknown> = {
  ...jsonSchemaOf(v.union([itemEnvelopeSchema(meetingPreparation), errorObjectSchema])),
}
const { communications: _, ...withoutCommunications } = meetingPreparationInput.entries
const inputs = {
  with: { ...jsonSchemaOf(meetingPreparationInput) } as Record<string, unknown>,
  without: { ...jsonSchemaOf(v.strictObject(withoutCommunications)) } as Record<string, unknown>,
}

/** `communications: true` from a host that connects a messages source; without one the argument could only refuse. */
export const meetingPreparationTool = ({ communications = false }: { communications?: boolean } = {}) => ({
  name: "meeting_prepare",
  description: `Prepare cited context for one exact provider series in the server's selected account. Reads remote upcoming proof and bounded stored history, related meeting transcripts through explicit people/confirmed project links, accepted meeting facts and directly sourced tasks; performs no writes. Optional project selects one existing project name/key/alias for up to four bounded word-evidence pages across the selected account and history window; matches remain unconfirmed and do not infer membership. ${communications ? "Optional communications searches only explicit host-captured source IDs with literal words, bounded excerpts and independent index/read/output coverage; it does not infer identity or project membership. Each source may resume with its opaque cursor; restart_required means narrow or restart that selection rather than advancing. " : ""}Optional ISO windows default to now, seven days ahead and thirty days of history. Coverage identifies incomplete and unqueried context. ${UNTRUSTED_NEUTRAL}`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { ...(communications ? inputs.with : inputs.without), type: "object" as const },
  outputSchema: { ...outputSchema, type: "object" as const },
})
export const callMeetingPreparationTool = async (
  read: MeetingPreparationReader,
  input: unknown,
  signal?: AbortSignal,
  failure: FailureContext = {},
  now?: number,
  { communications = false }: { communications?: boolean } = {},
) => {
  try {
    if (!communications && input && typeof input === "object" && Object.hasOwn(input, "communications"))
      throw new CliError("validation_error", "unknown preparation argument: communications")
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
