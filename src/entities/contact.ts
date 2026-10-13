import * as v from "valibot"
import { id, reference, text, time } from "./fields.js"

/** Somebody in a messenger's contact list. */
export const contact = v.strictObject({
  ref: reference,
  id,
  name: v.nullable(text),
  username: v.nullable(text),
  alias: v.optional(v.nullable(text)),
  display_name: v.optional(v.nullable(text)),
  /** Whatever they wrote about themselves. */
  description: v.nullable(text),
  /** The newest message in a one-to-one chat with them. */
  last_messaged_at: v.nullable(time),
})
