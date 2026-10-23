import * as v from "valibot"
import { count, id, text } from "./fields.js"

export const poll = v.strictObject({
  chat_id: id,
  message_id: id,
  question: text,
  answers: v.array(v.strictObject({ id, text, voters: v.nullable(count), chosen: v.boolean() })),
  closed: v.boolean(),
  multiple: v.boolean(),
  anonymous: v.boolean(),
  voters: v.nullable(count),
  quiz: v.optional(v.boolean()),
  revote: v.optional(v.boolean()),
  creator: v.optional(v.boolean()),
})

export const pollChange = v.strictObject({ operation_id: id, poll })
