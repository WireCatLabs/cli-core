import * as v from "valibot"
import { id, text } from "./fields.js"

const named = v.strictObject({
  id,
  title: v.nullable(text),
  kind: v.nullable(v.picklist(["dialog", "group", "channel", "saved", "unknown"])),
})

/** One of the owner's chat folders. */
export const folder = v.strictObject({
  id,
  title: text,
  /** Chats added by hand; a folder that selects chats by a rule of its own lists none. */
  chat_ids: v.array(id),
  emoji: v.optional(text),
  /** Kinds of chat it takes by itself. */
  include: v.optional(v.array(v.picklist(["contacts", "non-contacts", "groups", "channels", "bots"]))),
  skip: v.optional(v.array(v.picklist(["muted", "read", "archived"]))),
  excluded_chat_ids: v.optional(v.array(id)),
  pinned_chat_ids: v.optional(v.array(id)),
  /** `chats folders show`: the chats in it, pinned and left out, by name. */
  chats: v.optional(v.array(named)),
  pinned_chats: v.optional(v.array(named)),
  excluded_chats: v.optional(v.array(named)),
})
