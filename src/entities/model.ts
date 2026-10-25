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
  /** What its files take on disk once downloaded. */
  size_bytes: count,
  downloaded: v.boolean(),
  /** The one used when no model is named. */
  default: v.boolean(),
  /** The folder its files are in once downloaded, so an agent can place them by hand. */
  path: text,
})
