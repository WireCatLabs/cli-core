import * as v from "valibot"
import { id, time } from "./fields.js"
import { message } from "./message.js"

export const messageWrite = v.strictObject({
  operation_id: id,
  message,
  /** An album's messages, in order; `message` is the first. Absent for a single message. */
  messages: v.optional(v.array(message)),
  scheduled_for: v.optional(time),
})

export const draftWrite = v.strictObject({
  operation_id: id,
  chat_id: id,
  saved: v.literal(true),
})

export const messageSend = v.union([messageWrite, draftWrite])
