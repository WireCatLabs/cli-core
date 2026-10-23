import * as v from "valibot"
import { id, text, time } from "./fields.js"

export const recipient = v.strictObject({ id, title: v.nullable(text), partner_id: v.optional(id), added_at: time })
export const recipientAdded = v.strictObject({ id, title: v.nullable(text), added: v.boolean() })
export const recipientRemoved = v.strictObject({ id, title: v.nullable(text), removed: v.boolean() })
export const recipientOff = v.strictObject({ off: v.boolean(), was_on: v.boolean() })
export const recipientChange = v.strictObject({
  ...v.partial(recipientAdded).entries,
  ...v.partial(recipientRemoved).entries,
  ...v.partial(recipientOff).entries,
})
