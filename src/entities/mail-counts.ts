import * as v from "valibot"
import { count, text } from "./fields.js"

/** Stored mail received and sent, one row per calendar day, week (by its Monday) or sender. */
export const mailCounts = v.strictObject({
  by: v.picklist(["day", "week", "sender"]),
  received: count,
  sent: count,
  rows: v.array(
    v.strictObject({
      /** `YYYY-MM-DD`, or the sender's address. */
      key: text,
      name: v.nullable(text),
      received: count,
      /** Always 0 by sender: the owner sends that mail. */
      sent: count,
    }),
  ),
})
