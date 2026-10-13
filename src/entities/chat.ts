import * as v from "valibot"
import { count, id, providerMetadata, reference, text, time } from "./fields.js"

export const chat = v.strictObject({
  ref: reference,
  id,
  provider: v.optional(text),
  account: v.optional(text),
  title: v.nullable(text),
  kind: v.picklist(["dialog", "group", "channel", "saved", "unknown"]),
  unreadCount: v.nullable(count),
  unreadMentions: v.optional(count),
  lastMessageAt: v.nullable(time),
  participantsCount: v.nullable(count),
  muted: v.optional(v.boolean()),
  archived: v.optional(v.boolean()),
  membershipState: v.optional(v.picklist(["joined", "left", "public", "imported", "archived", "external"])),
  parentChatId: v.optional(id),
  scope: v.optional(v.picklist(["personal", "work"])),
  providerMetadata,
})
