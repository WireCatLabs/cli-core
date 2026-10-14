import * as v from "valibot"
import { chat } from "./chat.js"
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
  /** `contacts show`: the chats shared with them. */
  chats: v.optional(v.array(v.pick(chat, ["ref", "id", "title", "kind", "last_message_at"]))),
  /** `contacts show --with-notes`: the owner's private notes about them. */
  notes: v.optional(v.array(v.strictObject({ id, text, revision: count, created_at: time, updated_at: time }))),
})
