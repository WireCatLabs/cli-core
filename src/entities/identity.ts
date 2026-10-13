import * as v from "valibot"
import { id, reference, text } from "./fields.js"

/** One account of a person in one messenger or mailbox. */
export const identity = v.strictObject({
  ref: reference,
  provider: text,
  account: text,
  /** The messenger's own id for them. */
  id,
  name: v.nullable(text),
  username: v.nullable(text),
  /** The `person:` they are linked to, when one is. */
  person: v.optional(v.nullable(reference)),
})
