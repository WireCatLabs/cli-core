import * as v from "valibot"
import { id, time } from "./fields.js"

const operated = { operation_id: id, chat_id: id }
export const chatRemoval = v.strictObject(operated)
export const chatMuting = v.strictObject({
  ...operated,
  muted_until: v.nullable(v.union([time, v.literal("forever")])),
})
export const chatArchive = v.strictObject({ ...operated, archived: v.boolean() })
export const chatPin = v.strictObject({ ...operated, pinned: v.boolean() })
export const chatUnread = v.strictObject({ ...operated, unread: v.literal(true) })
