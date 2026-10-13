import * as v from "valibot"
import { count, id, providerMetadata, reference, text, time } from "./fields.js"

export const chat = v.strictObject({
  ref: reference,
  id,
  provider: v.optional(text),
  account: v.optional(text),
  title: v.nullable(text),
  kind: v.picklist(["dialog", "group", "channel", "saved", "unknown"]),
  unread_count: v.nullable(count),
  unread_mentions: v.optional(count),
  last_message_at: v.nullable(time),
  participants_count: v.nullable(count),
  muted: v.optional(v.boolean()),
  archived: v.optional(v.boolean()),
  membership_state: v.optional(v.picklist(["joined", "left", "public", "imported", "archived", "external"])),
  parent_chat_id: v.optional(id),
  scope: v.optional(v.picklist(["personal", "work"])),
  provider_metadata: providerMetadata,
})
