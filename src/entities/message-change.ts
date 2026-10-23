import * as v from "valibot"
import { id } from "./fields.js"

const operated = { operation_id: id, chat_id: id }
export const messagePin = v.strictObject({ ...operated, message_id: id, pinned: v.boolean() })
export const messageStar = v.strictObject({ ...operated, message_id: id, starred: v.boolean() })
export const messageDeletion = v.strictObject({ ...operated, deleted: v.array(id), for_everyone: v.boolean() })
