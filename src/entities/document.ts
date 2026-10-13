import * as v from "valibot"
import { count, id, reference, text, time } from "./fields.js"

/** A file kept elsewhere — Google Drive, a notes folder, a message. */
export const document = v.strictObject({
  ref: reference,
  id,
  title: v.nullable(text),
  url: v.nullable(text),
  mime: v.optional(text),
  size: v.optional(count),
  /** When its source last changed it. */
  modifiedAt: v.nullable(time),
  /** When the store last read it; not the source's time. */
  storedAt: v.optional(v.nullable(time)),
  owners: v.optional(v.array(text)),
})
