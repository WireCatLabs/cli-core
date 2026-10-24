import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { MEETING_RESULT_ENTITIES } from "../meetings/index.js"
import { snakeKeys } from "./envelope.js"

const ids = new Set([
  "meeting_id",
  "account_id",
  "participant_id",
  "event_id",
  "previous_event_id",
  "expected_event_id",
  "next_transcript_id",
])
const publicValue = (value: unknown, key = ""): unknown => {
  if (typeof value === "number" && ids.has(key)) return String(value)
  if (Array.isArray(value))
    return value.map((item) => publicValue(item, key === "target_account_ids" ? "account_id" : ""))
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, publicValue(item, name)]))
  return value
}

/** Store IDs stay numeric below the CLI; public receipts use the shared string IDs and validated wire fields. */
export const meetingResultItem = (entity: keyof typeof MEETING_RESULT_ENTITIES, value: unknown): unknown => {
  const parsed = v.safeParse(MEETING_RESULT_ENTITIES[entity] as v.GenericSchema, publicValue(snakeKeys(value)))
  if (!parsed.success) {
    const applied = value && typeof value === "object" && "applied" in value && value.applied === true
    throw new CliError(
      applied ? "outcome_unknown" : "invalid_response",
      `the command returned an invalid ${entity} answer`,
    )
  }
  return parsed.output
}
