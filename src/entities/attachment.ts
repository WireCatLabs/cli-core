import * as v from "valibot"
import { count, text } from "./fields.js"

export const attachment = v.strictObject({
  /** Lower-cased: `photo`, `video`, `file`, `voice`… */
  kind: text,
  /** Its place among the message's attachments, from 0. */
  position: v.optional(count),
  url: v.optional(text),
  name: v.optional(text),
  title: v.optional(text),
  mime: v.optional(text),
  size: v.optional(count),
  width: v.optional(count),
  height: v.optional(count),
  /** Seconds, for audio and video. */
  duration: v.optional(v.number()),
  /** The text read out of it; how it was read is `extraction`. */
  text: v.optional(text),
  extraction: v.optional(v.strictObject({ origin: text, extractor: text, chars: count, error: v.optional(text) })),
  local_path: v.optional(text),
  /** A bot's keyboard under the message, row by row; `messages press` presses one. */
  buttons: v.optional(
    v.array(
      v.array(
        v.strictObject({
          kind: v.picklist(["callback", "link", "message", "chat", "contact", "location", "app", "clipboard", "other"]),
          text,
          url: v.optional(text),
        }),
      ),
    ),
  ),
})
