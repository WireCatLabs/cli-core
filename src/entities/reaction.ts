import * as v from "valibot"
import { id, text, time } from "./fields.js"

/** One person's reaction to a message. */
export const reaction = v.strictObject({
  person: v.strictObject({ id, name: v.nullable(text), username: v.nullable(text) }),
  /** The emoji, or `custom:<id>` for a custom one. */
  reaction: text,
  reacted_at: time,
})
