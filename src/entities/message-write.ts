import * as v from "valibot"
import { id, time } from "./fields.js"
import { message } from "./message.js"

export const messageWrite = v.strictObject({
  operation_id: id,
  message,
  scheduled_for: v.optional(time),
})
