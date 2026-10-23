import * as v from "valibot"
import { count, id, text, time } from "./fields.js"

/** Somebody in a group, as its member list shows them. */
export const member = v.strictObject({
  id,
  name: v.nullable(text),
  username: v.nullable(text),
  role: v.optional(v.picklist(["owner", "admin", "member"])),
  /** `null` when their privacy hides it. */
  last_seen_at: v.optional(v.nullable(time)),
  registered_at: v.optional(v.nullable(time)),
  joined_at: v.optional(v.nullable(time)),
  /** Who added them or whose invite they used. */
  invited_by: v.optional(v.nullable(id)),
  is_bot: v.optional(v.boolean()),
  deleted: v.optional(v.boolean()),
  flagged: v.optional(v.picklist(["scam", "fake"])),
  has_photo: v.optional(v.boolean()),
  /** `chats members check`: how much they look like a bot — a hint, never a verdict. */
  score: v.optional(count),
  reasons: v.optional(v.array(text)),
  /** `chats members check --deep`: the whole person check, as `contacts check` answers it. */
  check: v.optional(v.record(v.string(), v.unknown())),
})
