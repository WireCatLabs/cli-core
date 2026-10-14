import * as v from "valibot"
import { count, id, reference, text, time } from "./fields.js"

/** The owner's private note on a stored contact, kept in the local store and never sent. */
export const contactNote = v.strictObject({
  id,
  /** The contact, as a `contact:` reference. */
  contact: reference,
  text,
  /** Starts at 1; an edit names the revision it read. */
  revision: count,
  created_at: time,
  updated_at: time,
})
