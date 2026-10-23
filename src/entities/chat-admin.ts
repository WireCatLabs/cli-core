import * as v from "valibot"
import { chat } from "./chat.js"
import { count, id, text, time } from "./fields.js"
import { folder } from "./folder.js"
import { inviteLink } from "./invite-link.js"

const operated = { operation_id: id, chat_id: id }
const group = v.strictObject({
  ...v.omit(chat, ["ref", "provider", "account", "invite_link", "members"]).entries,
  parent_chat_id: v.optional(v.nullable(id)),
  muted_until: v.optional(v.nullable(time)),
  description: v.nullable(text),
  link: v.nullable(text),
  settings: v.strictObject({
    ...v.unwrap(chat.entries.settings).entries,
    all_can_pin: v.nullable(v.boolean()),
    only_admins_add: v.nullable(v.boolean()),
    only_admins_call: v.nullable(v.boolean()),
    only_owner_edits_info: v.nullable(v.boolean()),
    members_see_link: v.nullable(v.boolean()),
  }),
})
/** Administrative receipts retain their raw group card, distinct from a formatted chats show item. */
export const chatGroupChange = v.union([
  v.strictObject({ operation_id: id, chat: group }),
  v.strictObject({ operation_id: id, requested: v.literal(true) }),
])
export const chatInspection = v.strictObject({
  kind: chat.entries.kind,
  title: v.nullable(text),
  id: v.nullable(id),
  username: v.nullable(text),
  participants_count: v.nullable(count),
  description: v.nullable(text),
  member: v.nullable(v.boolean()),
  approval_needed: v.optional(v.boolean()),
})
export const chatSender = v.strictObject({
  id,
  title: text,
  kind: v.picklist(["self", "channel", "group"]),
  premium_required: v.boolean(),
  default: v.boolean(),
})
export const chatRead = v.strictObject({ ...operated, until: v.nullable(id), thread_id: v.optional(id) })
export const chatMembersFetch = v.strictObject({
  chat_id: id,
  joined: v.array(id),
  gone: v.array(id),
  changed: v.array(id),
  read: count,
  participants: v.nullable(count),
  complete: v.boolean(),
  more: v.boolean(),
  tracked: v.boolean(),
})
export const chatMembersChange = v.union([
  v.strictObject({ ...operated, added: v.array(id), not_added: v.array(id) }),
  v.strictObject({ ...operated, removed: v.array(id) }),
])
export const chatInvite = v.strictObject({ chat_id: id, title: v.nullable(text), link: text })
export const chatInviteChange = v.strictObject({
  ...operated,
  ...v.omit(inviteLink, ["pending_count", "joined_count"]).entries,
  pending: v.optional(count),
  joined: v.optional(count),
})
export const chatRequestChange = v.union([
  v.strictObject({ ...operated, person_id: id, accepted: v.boolean(), already: v.boolean() }),
  v.strictObject({ chat_id: id, accepted: v.boolean(), counted: count, operation_id: v.optional(id) }),
])
export const chatAdminChange = v.strictObject({
  ...operated,
  person_id: id,
  rights: v.optional(
    v.array(v.picklist(["read", "members", "admins", "info", "pin", "link", "post", "edit", "delete"])),
  ),
})
export const chatFolderChange = v.strictObject({
  operation_id: id,
  folder: v.omit(folder, ["chats", "pinned_chats", "excluded_chats"]),
})
export const chatFolderRemoval = v.strictObject({ operation_id: id, folder_id: id })
export const chatFolderOrder = v.strictObject({
  operation_id: id,
  folders: v.array(v.strictObject({ id, title: text })),
})
