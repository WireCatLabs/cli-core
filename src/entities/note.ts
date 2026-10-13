import * as v from "valibot"
import { id, reference, text, time } from "./fields.js"

export const note = v.strictObject({
  ref: reference,
  id,
  source: v.picklist(["file", "internal"]),
  folder_id: v.nullable(id),
  path: v.nullable(text),
  title: v.nullable(text),
  text,
  created_at: time,
  /** When the store's copy last changed. */
  updated_at: time,
  deleted_at: v.optional(v.nullable(time)),
})
