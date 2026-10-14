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
  /** The first line holding a word of a search. */
  excerpt: v.optional(text),
  /** Which halves of a search found it. */
  found_by: v.optional(v.array(v.picklist(["words", "meaning"]))),
  /** What the note links to; `to` is null while the name written matches nothing stored. */
  links: v.optional(
    v.array(
      v.strictObject({
        to: v.nullable(reference),
        target_text: v.nullable(text),
        kind: text,
        anchor: v.nullable(text),
      }),
    ),
  ),
})
