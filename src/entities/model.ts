import * as v from "valibot"
import { count, id, text } from "./fields.js"

/**
 * A model that runs on this machine: speech for voice messages, text for meaning search, image for pictures,
 * reranker for the order of `search messages --discover`.
 */
export const model = v.strictObject({
  id,
  kind: v.picklist(["audio", "text", "image", "reranker"]),
  title: text,
  /** Which languages it reads, in words. */
  languages: text,
  licence: v.optional(text),
  /** A text model's licence terms to accept with `models download --accept-terms`. */
  terms: v.optional(text),
  /** A text model's size next to the others: small is fastest, large reads best. */
  size: v.optional(v.picklist(["small", "medium", "large"])),
  /** A text model's vector length. */
  dims: v.optional(count),
  /** About how many chunks a second a text model embeds here, when measured. */
  chunks_per_second: v.optional(v.number()),
  /** A text model the owner added with `models add`. */
  custom: v.optional(v.boolean()),
  /** What its files take on disk once downloaded. */
  size_bytes: count,
  downloaded: v.boolean(),
  /** The one used when no model is named: for text, the one `models use` chose. */
  default: v.boolean(),
  /** The folder its files are in once downloaded, so an agent can place them by hand. */
  path: text,
})
