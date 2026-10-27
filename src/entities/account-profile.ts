import * as v from "valibot"
import { id, text } from "./fields.js"

export const accountProfile = v.strictObject({
  profile: id,
  current: v.boolean(),
  account: v.nullable(id),
  name: v.nullable(text),
  /** False for a profile with no session on this computer; absent when the messenger does not say. */
  signed_in: v.optional(v.boolean()),
})
