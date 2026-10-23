import * as v from "valibot"
import { count, id, reference, text, time } from "./fields.js"

export const messageTranscript = v.strictObject({
  message_id: id,
  text,
  pending: v.boolean(),
  via: text,
  model: v.optional(text),
})

export const conversationLink = v.strictObject({
  parent_id: v.nullable(id),
  source: v.picklist(["provider", "rule", "agent"]),
  kind: text,
  confidence: v.number(),
  method: text,
  version: v.nullable(text),
  created_at: time,
  stale: v.boolean(),
  chosen: v.boolean(),
})
export const messageLinks = v.strictObject({
  chat: id,
  message: id,
  links: v.array(conversationLink),
  chain: v.array(id),
})

const fingerprint = v.pipe(text, v.regex(/^[a-f0-9]{64}$/))
export const evidencePacket = v.strictObject({
  schema_version: v.literal(1),
  id,
  kind: v.picklist(["chats", "news", "person"]),
  source: v.strictObject({ provider: text, account: id, chat: id }),
  fingerprint,
  limits: v.strictObject({ messages: count, bytes: count }),
  content_bytes: count,
  coverage: v.strictObject({
    provided: count,
    included: count,
    omitted: count,
    has_more: v.boolean(),
    history: v.literal("unknown"),
    truncated_by: v.nullable(v.picklist(["messages", "bytes"])),
  }),
  items: v.array(
    v.strictObject({
      locator: reference,
      fingerprint,
      timestamp: time,
      edited_at: v.nullable(time),
      sender_id: v.nullable(id),
      sender_name: v.nullable(text),
      sender_is_chat: v.boolean(),
      outgoing: v.nullable(v.boolean()),
      text,
      reply_to: v.nullable(reference),
      thread_id: v.nullable(id),
      attachment_kinds: v.array(text),
    }),
  ),
})
