import * as v from "valibot"
import { chat } from "./chat.js"
import { profileFields } from "./contact-read.js"
import { count, id, reference, text, time } from "./fields.js"

/** Somebody in a messenger's contact list. */
export const contact = v.strictObject({
  ref: reference,
  id,
  name: v.nullable(text),
  username: v.nullable(text),
  alias: v.optional(v.nullable(text)),
  display_name: v.optional(v.nullable(text)),
  /** Whatever they wrote about themselves. */
  description: v.nullable(text),
  /** The newest message in a one-to-one chat with them. */
  last_messaged_at: v.nullable(time),
  /** For a source that knows it, such as a Zoom contact. */
  email: v.optional(v.nullable(text)),
  phones: v.optional(v.array(v.strictObject({ number: text, label: v.nullable(text) }))),
  /** `contacts show`: the chats shared with them, and what the store holds of their messages in each. */
  chats: v.optional(
    v.array(
      v.strictObject({
        ...v.pick(chat, ["ref", "id", "title", "kind", "last_message_at"]).entries,
        /** Their messages stored; a floor unless `complete`. */
        their_messages: v.optional(count),
        first_at: v.optional(v.nullable(time)),
        last_at: v.optional(v.nullable(time)),
        /** The store holds the whole chat, so the count is the real one. */
        complete: v.optional(v.boolean()),
      }),
    ),
  ),
  /** `contacts show`: what the messenger says about them, or with `--offline` what the store saw of them. */
  ...v.partial(v.strictObject(profileFields)).entries,
  /** `contacts show --with-notes`: the owner's private notes about them. */
  notes: v.optional(v.array(v.strictObject({ id, text, revision: count, created_at: time, updated_at: time }))),
})
