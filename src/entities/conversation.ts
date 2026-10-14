import * as v from "valibot"
import { count, id, reference, time } from "./fields.js"

/** A thread inside a group chat, found by rules over the stored messages: replies, mentions, who wrote next. */
export const conversation = v.strictObject({
  id,
  chat: reference,
  /** The message it starts with. */
  first_message: reference,
  started_at: time,
  ended_at: time,
  messages_count: count,
  /** How many people wrote in it. */
  senders_count: count,
  built_at: time,
  rules_version: count,
})
