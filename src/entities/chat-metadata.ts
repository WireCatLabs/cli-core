import * as v from "valibot"
import { id, text, time } from "./fields.js"

export const chatMetadata = v.strictObject({
  chat_id: id,
  title: v.nullable(text),
  username: v.nullable(text),
  description: v.nullable(text),
  fetched_at: time,
})
export const cachedChatMetadata = v.strictObject({ chat_id: id, metadata: v.nullable(chatMetadata) })
const failedChatMetadata = v.strictObject({ chat_id: id, error: v.strictObject({ code: text, message: text }) })
export const chatMetadataRefresh = v.strictObject({
  chats: v.array(v.union([chatMetadata, failedChatMetadata])),
  has_more: v.boolean(),
})
