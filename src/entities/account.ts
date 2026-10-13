import * as v from "valibot"
import { id, text } from "./fields.js"

/** Who a profile is signed in as. `id` is the messenger's own id, never the store's row number. */
export const account = v.strictObject({
  provider: text,
  id,
  name: v.nullable(text),
  username: v.nullable(text),
  phone: v.optional(v.nullable(text)),
  scope: v.optional(v.picklist(["personal", "work"])),
})
