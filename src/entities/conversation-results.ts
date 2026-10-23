import * as v from "valibot"
import { conversation } from "./conversation.js"
import { chatEmbedding, conversationBuild, conversationPreparation } from "./conversation-preparation.js"
import { count, id, reference, text, time } from "./fields.js"
import { message } from "./message.js"

/** JSON returns the conversation with its messages; JSONL streams the messages themselves. */
export const conversationDetails = v.union([
  v.strictObject({ ...conversation.entries, messages: v.array(message) }),
  message,
])
export const conversationBatchStatus = v.strictObject({
  chat: id,
  messages: count,
  characters: count,
  batches: count,
  tokens_estimate: count,
})
const batchMessage = v.strictObject({
  id,
  at: time,
  sender: v.strictObject({ id: v.nullable(id), name: v.nullable(text) }),
  text,
  reply_to: v.optional(id),
  thread: v.optional(id),
  mentions: v.optional(v.array(id)),
  answer: v.boolean(),
  candidates: v.optional(
    v.array(v.strictObject({ parent: v.nullable(id), source: text, kind: text, confidence: v.number() })),
  ),
})
export const conversationBatch = v.union([
  v.strictObject({ batch: v.null() }),
  v.strictObject({
    batch: id,
    chat: id,
    messages: v.array(batchMessage),
    remaining: v.strictObject({ messages: count, characters: count }),
  }),
])
const analyzedConversation = v.strictObject({
  chat: id,
  model: text,
  batches: count,
  stored: count,
  tokens: count,
  reserved_tokens: count,
  max_tokens: count,
  stopped: v.picklist(["complete", "budget"]),
  remaining: conversationBatchStatus,
  built: v.optional(conversationBuild),
})
export const conversationBuildResult = v.union([conversationBuild, conversationPreparation, analyzedConversation])
export const conversationEmbedding = v.union([chatEmbedding, conversationPreparation])
export const conversationChange = v.union([
  v.strictObject({ chat: id, stored: count }),
  v.strictObject({ chat: id, cleared: count }),
])
export const conversationReadiness = v.strictObject({
  chat: id,
  model: text,
  state: v.picklist(["ready", "stale", "partial", "words-only", "not-built"]),
  graph: v.nullable(v.strictObject({ built_at: time, rules_version: v.nullable(count), outdated_rules: v.boolean() })),
  pending: v.strictObject({ new: count, edited: count, deleted: count }),
  vectors: v.strictObject({ chunks: count, current: count, stale: count, missing: count }),
})
export const conversationEmbeddingStatus = v.strictObject({
  chat: id,
  model: text,
  chunks: count,
  embedded: count,
  left: count,
  estimate_seconds: v.nullable(v.number()),
  tokens_at_most: count,
  price_at_most: v.optional(v.strictObject({ usd: v.number(), read: text })),
})
const summary = v.strictObject({
  id,
  chat_id: id,
  first_message_id: id,
  first_at: time,
  last_at: time,
  message_count: count,
  senders: count,
  built_at: time,
  algorithm_version: count,
})
export const conversationHit = v.strictObject({
  source: v.optional(v.strictObject({ provider: text, account: id })),
  locator: v.optional(reference),
  summary,
  chunk: v.strictObject({ first_message_id: id, last_message_id: id }),
  score: v.nullable(v.number()),
  matched_in: v.optional(v.literal("context")),
  by: v.array(v.picklist(["meaning", "words"])),
  stale: v.boolean(),
})
