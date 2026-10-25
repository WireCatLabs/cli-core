import * as v from "valibot"
import { count, id, text, time } from "./fields.js"

export const conversationBuild = v.strictObject({
  chat: id,
  messages: count,
  links: count,
  conversations: count,
  built_at: time,
  rules_version: count,
})
export const chatEmbedding = v.strictObject({ chat: id, model: text, embedded: count, skipped: count })
export const conversationPreparation = v.strictObject({
  model: text,
  model_available: v.boolean(),
  built: v.array(conversationBuild),
  embedded: v.array(chatEmbedding),
  left: v.array(v.strictObject({ chat: id, needs: v.picklist(["build", "embed"]) })),
  /** Messages given their own vector, which `search messages --discover` reads, and how many still lack one. */
  messages: v.optional(v.strictObject({ embedded: count, left: count })),
})
export const catchUpPreparation = v.strictObject({
  complete: v.boolean(),
  reason: v.optional(v.picklist(["message_bound", "time_or_abort_bound", "preparation_failed", "pending"])),
  prepared: v.optional(conversationPreparation),
})
