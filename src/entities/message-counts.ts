import * as v from "valibot"
import { count, reference, text } from "./fields.js"

/** How many stored messages match, one row per chat, sender, day or hour. */
export const messageCounts = v.strictObject({
  by: v.picklist(["chat", "sender", "day", "hour"]),
  total: count,
  rows: v.array(
    v.strictObject({
      /** The chat or sender id, or the calendar day or hour. */
      key: text,
      ref: v.optional(reference),
      name: v.nullable(text),
      count,
    }),
  ),
})
