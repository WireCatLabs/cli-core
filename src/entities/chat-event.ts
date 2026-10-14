import * as v from "valibot"
import { id, text, time } from "./fields.js"

const who = v.strictObject({ id: v.nullable(id), name: v.nullable(text), username: v.optional(v.nullable(text)) })

/** Somebody joined, left, was added or removed, or changed their profile, in one chat. */
export const chatEvent = v.strictObject({
  chat_id: id,
  time,
  /** `join`, `leave`, `add`, `remove`, `create`, `title`, `pin`, `profile`; a messenger may pass others through. */
  type: text,
  /** The service message that says so, where there is one. */
  message_id: v.optional(id),
  by: v.optional(who),
  people: v.array(who),
  /** `create` and `title` carry the chat's title. */
  title: v.optional(text),
  /** `profile`: the name and username seen before. */
  before: v.optional(v.strictObject({ name: v.nullable(text), username: v.nullable(text) })),
})
