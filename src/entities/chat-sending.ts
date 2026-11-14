import * as v from "valibot"
import { text, time } from "./fields.js"

/** `models chats`: whether chat text may go to a model outside this computer. */
export const chatSending = v.strictObject({
  mode: v.picklist(["allowed", "ask", "denied"]),
  meaning: text,
  /** When the owner last set it; `null` while it is the default, ask. */
  since: v.nullable(time),
  /** `set` only: whether this run changed it. */
  changed: v.optional(v.boolean()),
})
