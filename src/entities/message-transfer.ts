import * as v from "valibot"
import { actionableError, batchResult } from "./batch-result.js"
import { catchUpPreparation } from "./conversation-preparation.js"
import { extractionReport, extractionSummary } from "./extraction-report.js"
import { count, id, text } from "./fields.js"

export const savedMessageFile = v.strictObject({
  kind: text,
  path: text,
  bytes: count,
  existing: v.optional(v.literal(true)),
})
const files = v.array(savedMessageFile)
export const messageDownload = v.union([
  v.strictObject({
    files,
    extraction: v.optional(extractionReport),
    complete: v.optional(v.literal(false)),
    batch: v.optional(batchResult),
  }),
  v.strictObject({
    files,
    chat: v.nullable(id),
    saved: count,
    existing: count,
    complete: v.boolean(),
    batch: v.optional(batchResult),
    stopped: v.optional(v.literal(true)),
    extraction: v.optional(extractionSummary),
  }),
])

/** Opaque history keys: numeric message IDs, or time indexing selected by the provider. */
const historyRange = v.strictObject({ from: v.number(), to: v.number() })
export const messageSyncEstimate = v.strictObject({
  chat: id,
  held: count,
  ranges: v.array(historyRange),
  missing: v.nullable(count),
  requests: v.nullable(count),
  runs: v.nullable(count),
  seconds: v.nullable(count),
})
const tasks = v.optional(
  v.strictObject({
    added: count,
    closed: count,
    review: count,
    held: v.optional(count),
    held_chats: v.optional(count),
  }),
)
export const messageSyncChat = v.strictObject({
  issue: v.optional(actionableError),
  resume: v.optional(v.strictObject({ before: v.optional(text) })),
  prepared: v.optional(catchUpPreparation),
  window_complete: v.optional(v.boolean()),
  requests: v.optional(count),
  chat: v.nullable(id),
  fetched: count,
  complete: v.boolean(),
  ranges: v.array(historyRange),
  reached_since: v.optional(v.literal(true)),
  reached_last: v.optional(v.literal(true)),
  stopped: v.optional(v.literal(true)),
  tasks,
  /** `--full-history`: the chat's pushed history is now kept in full; `false` when the store does not know the chat. */
  history_included: v.optional(v.boolean()),
})
export const messageSyncAll = v.strictObject({
  batch: v.optional(batchResult),
  chats: count,
  fetched: count,
  complete: v.boolean(),
  stopped: v.optional(v.literal(true)),
  items: v.array(
    v.strictObject({
      chat: id,
      title: v.nullable(text),
      fetched: count,
      complete: v.boolean(),
      current: v.optional(v.literal(true)),
      stopped: v.optional(v.literal(true)),
      error: v.optional(text),
      issue: v.optional(actionableError),
    }),
  ),
  tasks,
})
export const messageSyncStarted = v.strictObject({ job: id, pid: count, chat: text, log: text })
export const messageSync = v.union([messageSyncEstimate, messageSyncChat, messageSyncAll, messageSyncStarted])
