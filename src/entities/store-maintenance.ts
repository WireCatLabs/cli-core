import * as v from "valibot"
import { count, text, time } from "./fields.js"

const absent = v.strictObject({ path: text, exists: v.literal(false) })
const schema = v.strictObject({ version: count, min_compatible: count, writable: v.boolean(), speaks: count })
const wordIndex = v.strictObject({
  watermark: count,
  filled_through: count,
  pending_normalization: count,
  ready: v.boolean(),
  terms_through: count,
  newest: count,
  terms_ready: v.boolean(),
  built_at: v.nullable(time),
})
const stemIndex = v.strictObject({
  watermark: count,
  filled_through: count,
  pending: count,
  built: v.nullable(text),
  wanted: text,
  ready: v.boolean(),
  cause: v.optional(v.picklist(["building", "stemmer_changed", "stemmer_unknown"])),
  built_at: v.nullable(time),
})
const readFailure = { path: text, exists: v.literal(true), opens: v.literal(false), error: text }
const rows = v.partial(
  v.strictObject({ accounts: count, chats: count, messages: count, attachments: count, identities: count }),
)
export const storeInfo = v.union([
  absent,
  v.strictObject(readFailure),
  v.strictObject({
    path: text,
    exists: v.literal(true),
    bytes: v.strictObject({ file: count, wal: count }),
    schema,
    rows,
    pending_normalization: v.nullable(count),
    word_index: v.nullable(wordIndex),
    stem_index: v.nullable(stemIndex),
  }),
])
export const storeCheck = v.union([
  v.strictObject({ ...absent.entries, ok: v.literal(true) }),
  v.strictObject({ ...readFailure, ok: v.literal(false) }),
  v.strictObject({
    path: text,
    exists: v.literal(true),
    opens: v.literal(true),
    ok: v.boolean(),
    checks: v.strictObject({
      schema: v.boolean(),
      integrity: v.boolean(),
      foreign_keys: v.boolean(),
      search_indexes: v.boolean(),
      disk: v.boolean(),
    }),
    schema,
    integrity: v.array(text),
    foreign_key_violations: count,
    search_indexes: v.record(text, text),
    disk: v.strictObject({ free: count, needed: count }),
    pending_normalization: v.nullable(count),
    word_index: v.nullable(wordIndex),
    stem_index: v.nullable(stemIndex),
    chats_behind: v.array(
      v.strictObject({
        provider: text,
        account: text,
        chat: text,
        title: v.nullable(text),
        newest: time,
        held: v.nullable(time),
        refreshed: time,
      }),
    ),
    orphan_pointers: v.array(v.strictObject({ table: text, pointer: text, type: text, count, known: v.boolean() })),
    conversations: v.array(
      v.strictObject({
        provider: text,
        account: text,
        chat: text,
        title: v.nullable(text),
        built_at: v.nullable(time),
        rules_version: v.nullable(count),
        current: v.boolean(),
        stale_agent_links: count,
      }),
    ),
    vectors: v.nullable(v.strictObject({ models: v.record(text, count), unused: count })),
    not_applicable: v.strictObject({ extensions: text }),
  }),
])
const indexed = { normalized: count, indexed: count, terms: count, stemmed: count, notes_indexed: count }
export const storeMigration = v.union([
  absent,
  v.strictObject({ path: text, exists: v.literal(true), from: count, to: count, ...indexed }),
])
export const storeReindex = v.union([
  absent,
  v.strictObject({ path: text, exists: v.literal(true), ...indexed, file_texts: count, involvements: count }),
])
export const storeBackup = v.strictObject({
  path: text,
  from: text,
  bytes: count,
  schema: count,
  rows: v.strictObject({ chats: count, messages: count }),
  encrypted: v.optional(v.literal(true)),
})
export const storeDecrypt = v.strictObject({ path: text, from: text, bytes: count })
export const storeRestore = v.strictObject({
  path: text,
  restored_from: text,
  kept_at: v.nullable(text),
  schema: count,
})
export const storeReset = v.union([
  v.strictObject({ ...absent.entries, reset: v.literal(false) }),
  v.strictObject({
    path: text,
    exists: v.literal(true),
    reset: v.literal(true),
    backup: v.nullable(text),
    backed_up: v.nullable(
      v.strictObject({ schema: count, rows: v.partial(v.strictObject({ chats: count, messages: count })) }),
    ),
    schema: count,
  }),
])
export const storeRepair = v.union([
  absent,
  v.strictObject({
    path: text,
    dry_run: v.boolean(),
    repaired: v.array(
      v.strictObject({
        table: text,
        action: v.picklist(["created", "columns-added", "rebuilt"]),
        columns_added: v.optional(v.array(text)),
        copy: v.optional(text),
        rows_in_copy: v.optional(count),
        rows_copied: v.optional(count),
        only_in_copy: v.optional(v.array(text)),
        dropped_from_copy: v.optional(v.array(text)),
      }),
    ),
    indexes_created: v.array(text),
    triggers_created: v.array(text),
    mismatches: v.array(v.strictObject({ table: text, what: text })),
    foreign_key_violations: v.array(v.strictObject({ table: text, rows: count })),
    copies: v.array(v.strictObject({ name: text, rows: count })),
  }),
])
export const storeCopyRemoval = v.strictObject({ path: text, deleted: v.strictObject({ name: text, rows: count }) })
