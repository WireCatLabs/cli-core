import * as v from "valibot"
import { id, text } from "./fields.js"

export const reactionChange = v.strictObject({
  operation_id: id,
  chat_id: id,
  message_id: id,
  reaction: v.nullable(text),
})
