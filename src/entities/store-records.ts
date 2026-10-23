import * as v from "valibot"
import { batchResult } from "./batch-result.js"
import { chat } from "./chat.js"
import { catchUpPreparation } from "./conversation-preparation.js"
import { count, id, text, time } from "./fields.js"
import { job } from "./job.js"
import { message } from "./message.js"
import { messageSyncStarted } from "./message-transfer.js"

const range = v.strictObject({ from: v.number(), to: v.number() })
export const storeChatStatus = v.strictObject({
  chat_id: id,
  title: v.nullable(text),
  kind: chat.entries.kind,
  messages: count,
  oldest_at: v.nullable(time),
  newest_at: v.nullable(time),
  last_stored_at: v.nullable(time),
  held: v.array(range),
})
export const storeClear = v.strictObject({
  cleared: v.boolean(),
  dry_run: v.optional(v.literal(true)),
  chats: count,
  messages: count,
  left: v.array(v.strictObject({ id, title: v.nullable(text), messages: count })),
})
/** Exports answer with message rows, one written file, or an incremental directory receipt. */
export const storeExport = v.union([
  message,
  v.strictObject({
    path: text,
    format: v.picklist(["jsonl", "markdown"]),
    count,
    encrypted: v.optional(v.literal(true)),
  }),
  v.strictObject({
    path: text,
    encrypted: v.optional(v.literal(true)),
    chats: v.array(
      v.strictObject({ id, title: v.nullable(text), file: v.nullable(text), messages: count, deleted: count }),
    ),
  }),
])
export const storeGapPlan = v.strictObject({
  version: v.literal(1),
  scope: v.literal("interior"),
  account: v.strictObject({ provider: text, account: id }),
  chat: id,
  ordering: v.picklist(["id", "time"]),
  held: v.array(range),
  gaps: v.array(range),
  unknown: v.strictObject({ older: v.boolean(), newer: v.literal(true) }),
  fingerprint: text,
  limits: v.strictObject({ max_gaps: count, limit: count, time_ms: count, page_size: count }),
})
export const storeGapRepair = v.union([
  messageSyncStarted,
  v.strictObject({
    version: v.literal(1),
    scope: v.literal("interior"),
    chat: id,
    before: storeGapPlan,
    after: storeGapPlan,
    repaired: v.array(range),
    fetched: count,
    requests: count,
    complete: v.boolean(),
    prepared: v.optional(catchUpPreparation),
    stopped: v.optional(v.picklist(["bound", "partial_or_inaccessible", "fetch_failed"])),
  }),
])
/** Persisted older jobs can lack recovery flags; newer diagnostics remain available. */
const problem = v.objectWithRest(
  { code: text, message: text, retryable: v.optional(v.boolean()), retry_after_ms: v.optional(v.number()) },
  v.unknown(),
)
const progress = v.strictObject({
  job: id,
  profile: text,
  done: count,
  total: v.nullable(count),
  remaining: v.nullable(count),
  state: v.picklist(["partial", "complete"]),
  updated_at: v.nullable(time),
  cursor_age_ms: v.nullable(count),
})
export const storeJobDetails = v.strictObject({
  ...v.omit(job, ["id", "issue", "error"]).entries,
  job: id,
  profile: text,
  issue: v.optional(problem),
  error: v.optional(problem),
  batch: v.optional(batchResult),
  resume: v.optional(v.strictObject({ before: v.optional(text) })),
  progress,
  held: v.optional(v.array(range)),
  log: text,
})
export const storeJobCancel = v.strictObject({ job: id, cancelled: v.literal(true) })
export const storeJobRetry = v.union([
  v.strictObject({ ...messageSyncStarted.entries, retried: id }),
  v.strictObject({ retried: id, chat: text, error: v.strictObject({ code: text, message: text }) }),
])
export const storeJobClear = v.strictObject({ cleared: v.array(id) })
