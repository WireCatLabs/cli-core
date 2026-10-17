import * as v from "valibot"
import { count, id, providerMetadata, reference, text, time } from "./fields.js"
import { member } from "./member.js"

const setting = v.optional(v.nullable(v.boolean()))

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
  /** `chats show`, a group or channel: what it says about itself. */
  description: v.optional(v.nullable(text)),
  invite_link: v.optional(v.nullable(text)),
  settings: v.optional(
    v.strictObject({
      all_can_pin: setting,
      only_admins_add: setting,
      only_admins_call: setting,
      only_owner_edits_info: setting,
      members_see_link: setting,
      join_approval: setting,
      only_admins_send: setting,
      only_admins_edit_info: setting,
      disappearing_seconds: v.optional(v.nullable(count)),
    }),
  ),
  /** `chats show`: who is in it, as far as anyone recorded; `null` when nobody did — a channel, always. */
  members: v.optional(v.nullable(v.array(member))),
})
