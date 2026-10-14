import * as v from "valibot"
import { counterReading, milliseconds } from "./counter-reading.js"
import { reference, text, time } from "./fields.js"
import { message } from "./message.js"

const evidenceMessage = v.pick(message, ["ref", "chat_title", "timestamp", "sender_name", "text"])

/** A message behind a ranking or report figure, with the message it answers where there is one. */
export const contribution = v.strictObject({
  message: evidenceMessage,
  related: v.optional(evidenceMessage),
  contribution: v.nullable(v.number()),
  counters: v.optional(v.array(counterReading)),
})

/** One member's stay behind a retention cohort. */
export const retentionStay = v.strictObject({
  person_ref: reference,
  joined_at: time,
  cohort: text,
  checkpoints: v.array(
    v.strictObject({
      checkpoint_ms: milliseconds,
      target_at: time,
      state: text,
      observed_at: v.nullable(time),
      lag_ms: v.nullable(milliseconds),
      complete: v.boolean(),
    }),
  ),
  activity: v.strictObject({
    state: text,
    first_message_at: v.nullable(time),
    window_end: v.nullable(time),
    archive_covered: v.boolean(),
  }),
  departure: v.strictObject({ after: v.nullable(time), at_or_before: v.nullable(time), early: text }),
})

export const evidence = v.union([contribution, retentionStay])
