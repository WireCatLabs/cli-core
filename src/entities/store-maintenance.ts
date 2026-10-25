import * as v from "valibot"
import { count, text, time } from "./fields.js"

const absent = v.strictObject({ path: text, exists: v.literal(false) })
const schema = v.strictObject({ version: count, min_compatible: count, writable: v.boolean(), speaks: count })
const infoSchema = v.strictObject({
  ...schema.entries,
  reason: v.picklist(["missing", "older", "current", "newer", "too_new"]),
  upgrade: v.nullable(v.strictObject({ version: count, min_compatible: count })),
})
const client = v.strictObject({ command: text, version: text, core: text, speaks: count, seen_at: time })
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
  v.strictObject({
    accounts: count,
    chats: count,
    messages: count,
    emails: count,
    documents: count,
    meetings: count,
    events: count,
    attachments: count,
    identities: count,
  }),
)
const perAccount = { chats: count, messages: count, emails: count, documents: count, meetings: count }
/** Over every account in the store; absent for a file with no schema yet. */
const contents = {
  by_provider: v.optional(v.array(v.strictObject({ provider: text, accounts: count, ...perAccount }))),
  by_chat_kind: v.optional(v.array(v.strictObject({ provider: text, kind: text, chats: count, messages: count }))),
  /** `name` is the one `account list` shows; the messenger's own id for the account is left out. */
  by_account: v.optional(
    v.array(v.strictObject({ provider: text, account_id: count, name: v.nullable(text), ...perAccount })),
  ),
  /** Calendar years in UTC. */
  by_year: v.optional(v.array(v.strictObject({ provider: text, year: count, messages: count }))),
  /** `type` is what the file is attached to: a message, an email, a document… `bytes` counts the sizes known. */
  by_attachment_kind: v.optional(v.array(v.strictObject({ type: text, kind: text, count, bytes: count }))),
}
export const storeInfo = v.union([
  v.strictObject({ ...absent.entries, schema: infoSchema }),
  v.strictObject({ ...readFailure, schema: v.strictObject({ speaks: count }) }),
  v.strictObject({
    path: text,
    exists: v.literal(true),
    bytes: v.strictObject({ file: count, wal: count }),
    journal_mode: text,
    /** `free` pages hold nothing; a `VACUUM` would give them back. */
    pages: v.strictObject({ size: count, count, free: count }),
    migrations: v.array(v.strictObject({ version: count, min_compatible: count, applied_at: time })),
    /** From the marker a backup job leaves in `backups/last.json` beside the store; null without one. */
    backup: v.nullable(v.strictObject({ at: time, file: v.nullable(text), checked: v.nullable(text) })),
    schema: infoSchema,
    clients: v.array(client),
    rows,
    pending_normalization: v.nullable(count),
    word_index: v.nullable(wordIndex),
    stem_index: v.nullable(stemIndex),
    ...contents,
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
