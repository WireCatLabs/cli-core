import * as v from "valibot"
import { chat } from "./chat.js"
import { id, text, time } from "./fields.js"

export const botProfile = v.strictObject({
  name: text,
  token: text,
  bot: v.optional(text),
  id: v.optional(id),
  problem: v.optional(text),
})

export const botSeenChat = v.strictObject({
  ...v.partial(v.omit(chat, ["ref", "provider", "account", "description", "invite_link", "settings", "members"]))
    .entries,
  id,
  parent_chat_id: v.optional(v.nullable(id)),
  muted_until: v.optional(v.nullable(time)),
  first_seen_at: v.optional(time),
  last_seen_at: v.optional(time),
})

export const botAdmin = v.strictObject({
  id,
  name: v.nullable(text),
  username: v.nullable(text),
  role: v.picklist(["owner", "admin"]),
  rights: v.array(v.picklist(["read", "members", "admins", "info", "pin", "link", "post", "edit", "delete"])),
  title: v.nullable(text),
})

export const botMenuEntry = v.strictObject({ name: text, description: v.nullable(text) })
export const botWebhook = v.strictObject({ url: text, types: v.nullable(v.array(text)) })

export const scheduledJob = v.strictObject({
  name: text,
  kind: v.picklist(["command", "agent"]),
  when: text,
  last: v.nullable(
    v.strictObject({
      at: time,
      exit_code: v.number(),
      output: text,
      trace_id: v.optional(text),
      reason: v.optional(text),
      error_code: v.optional(text),
      failing_since: v.optional(time),
      failures: v.optional(v.number()),
    }),
  ),
})

export const botTemplate = v.strictObject({
  name: v.nullable(text),
  status: v.nullable(text),
  language: v.nullable(text),
  category: v.nullable(text),
})
