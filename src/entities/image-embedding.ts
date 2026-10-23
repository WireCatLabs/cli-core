import * as v from "valibot"
import { count, text } from "./fields.js"

/** The bounded image batch's progress; failed and unreadable pictures remain distinct. */
export const imageEmbedding = v.strictObject({
  model: text,
  embedded: count,
  skipped: count,
  failed: count,
  more: v.boolean(),
})
