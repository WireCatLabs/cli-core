import * as v from "valibot"
import { TAG_TYPES } from "../domain/tags.js"
import { reference, text, time } from "./fields.js"

/** One tag on one chat, person or message. */
export const tagging = v.strictObject({
  tag: text,
  type: v.picklist(TAG_TYPES),
  /** What carries it: a `chat:`, `contact:` or `msg:` reference. */
  target: reference,
  /** The chat's title or the person's name, as the store holds it. */
  name: v.nullable(text),
  /** Who claims it: `manual` the owner, `auto` the keyword rules; both when both do. */
  sources: v.array(v.picklist(["manual", "auto"])),
  created_at: time,
})
