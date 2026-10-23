import * as v from "valibot"
import { chat } from "./chat.js"
import { count, id, text, time } from "./fields.js"

export const contactLookup = v.strictObject({ id, name: v.nullable(text), username: v.nullable(text) })
export const contactSync = v.strictObject({ added: count, changed: count, known: count })

export const contactProfile = v.strictObject({
  id,
  name: v.nullable(text),
  usernames: v.array(text),
  bio: v.nullable(text),
  birthday: v.optional(v.nullable(text)),
  phone: v.optional(v.nullable(text)),
  flags: v.partial(
    v.strictObject({
      bot: v.boolean(),
      verified: v.boolean(),
      premium: v.boolean(),
      scam: v.boolean(),
      fake: v.boolean(),
      restricted: v.boolean(),
      deleted: v.boolean(),
      support: v.boolean(),
    }),
  ),
  seen: v.optional(text),
  contact: v.optional(v.boolean()),
  mutual_contact: v.optional(v.boolean()),
  common_chats_count: v.optional(v.nullable(count)),
  registered: v.optional(
    v.nullable(
      v.strictObject({
        at: text,
        source: v.picklist(["telegram", "max", "estimate"]),
        precision: v.picklist(["day", "month"]),
      }),
    ),
  ),
  has_photo: v.optional(v.boolean()),
  chats: v.array(
    v.strictObject({
      id,
      title: v.nullable(text),
      kind: chat.entries.kind,
      their_messages: count,
      first_at: v.nullable(time),
      last_at: v.nullable(time),
      complete: v.boolean(),
    }),
  ),
  aliases: v.array(
    v.strictObject({
      name: v.optional(text),
      username: v.optional(text),
      link: v.optional(text),
      first_seen_at: time,
      last_seen_at: time,
      source: v.picklist(["profile", "messages"]),
    }),
  ),
})
