import * as v from "valibot"
import { reference, text } from "./fields.js"
import { identity } from "./identity.js"

/** One human across messengers and mailboxes. */
export const person = v.strictObject({
  ref: reference,
  name: v.nullable(text),
  identities: v.optional(v.array(identity)),
})
