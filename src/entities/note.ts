import * as v from "valibot"
import { id, reference, text, time } from "./fields.js"

export const note = v.strictObject({
  ref: reference,
  id,
  source: v.picklist(["file", "internal"]),
  folderId: v.nullable(id),
  path: v.nullable(text),
  title: v.nullable(text),
  text,
  createdAt: time,
  /** When the store's copy last changed. */
  updatedAt: time,
  deletedAt: v.optional(v.nullable(time)),
})
