import * as v from "valibot"
import { count, id, text, time } from "./fields.js"

export const sendAttempt = v.strictObject({
  at: time,
  profile: text,
  chat_id: v.nullable(id),
  outcome: v.picklist(["sent", "outcome_unknown", "refused", "failed", "reserved"]),
  kind: v.optional(v.picklist(["message", "reaction", "edit", "forward", "pin", "read", "delete", "chat", "account"])),
  action: v.optional(text),
  people: v.optional(count),
  message_id: v.optional(id),
  key: v.optional(text),
  count: v.optional(count),
  for_everyone: v.optional(v.boolean()),
  send_id: v.optional(id),
  operation_id: v.optional(id),
  parent_operation_id: v.optional(id),
  reply_to: v.optional(id),
  thread_id: v.optional(id),
  send_as: v.optional(id),
  result_chat_id: v.optional(id),
  length: v.optional(count),
  attachments: v.optional(
    v.array(v.strictObject({ kind: v.picklist(["photo", "file", "video", "voice", "sticker"]), bytes: count })),
  ),
  scheduled_for: v.optional(time),
  notify: v.optional(v.boolean()),
  origin: v.optional(text),
  reservation: v.optional(id),
  error_code: v.optional(text),
})
