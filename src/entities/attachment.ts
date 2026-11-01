import * as v from "valibot"
import { count, id, reference, text } from "./fields.js"

export const attachment = v.strictObject({
  /** The message it came with, as a locator; absent inside that message. */
  message: v.optional(reference),
  /** Lower-cased: `photo`, `video`, `file`, `voice`… */
  kind: text,
  /** Its place among the message's attachments, from 1, as `attachments show --attachment` takes it. */
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
  /** A shared contact card (`kind: "contact"`); the phone is the whole number as the sender put it. */
  contact: v.optional(
    v.strictObject({
      name: text,
      first_name: v.optional(text),
      last_name: v.optional(text),
      phone: v.optional(text),
      user_id: v.optional(id),
    }),
  ),
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

/** A file named on a search hit: `position` is the one `attachments show` and `messages download` take. */
export const hitFile = v.strictObject({ position: count, kind: text, name: v.optional(text), size: v.optional(count) })
