import * as v from "valibot"
import { count, id, reference, text, time } from "./fields.js"

const link = {
  target_text: v.nullable(text),
  kind: text,
  anchor: v.nullable(text),
}

export const note = v.strictObject({
  ref: reference,
  id,
  source: v.picklist(["file", "internal"]),
  folder_id: v.nullable(id),
  path: v.nullable(text),
  title: v.nullable(text),
  text,
  /** Raises on every edit; `notes edit --revision` takes it, so an edit made meanwhile is refused, not lost. */
  revision: count,
  /** A file's front matter as parsed, keys as the file writes them; null for a note without it. */
  front_matter: v.nullable(v.record(v.string(), v.unknown())),
  /** The hash of a file's bytes when last imported; null for a note written here. */
  content_hash: v.nullable(text),
  /** The file the note was exported to, where that is known; null otherwise. */
  export_path: v.nullable(text),
  created_at: time,
  /** When the store's copy last changed. */
  updated_at: time,
  deleted_at: v.optional(v.nullable(time)),
  tags: v.optional(v.array(text)),
  /** The first line holding a word of a search. */
  excerpt: v.optional(text),
  /** Which halves of a search found it. */
  found_by: v.optional(v.array(v.picklist(["title", "words", "meaning"]))),
  /** What the note links to; `to` is null while the name written matches nothing stored. */
  links: v.optional(v.array(v.strictObject({ to: v.nullable(reference), ...link }))),
  /** The notes and messages that link to it. */
  backlinks: v.optional(v.array(v.strictObject({ from: reference, ...link }))),
})
