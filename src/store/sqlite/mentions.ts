import { CliError } from "@wirecat/cli-base"
import { defineQuery, type QueryAst } from "@wirecat/cli-base/query"
import {
  findMentions,
  MENTION_KINDS,
  MENTION_VERSIONS,
  type MentionKind,
  normalizedValue,
  siteOf,
} from "../../domain/mentions.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import type { StoreContext } from "./open.js"
import { linkIdentityToPerson } from "./person-links.js"
import { type ColumnMap, queryFilter } from "./query-filter.js"

/** A stored mention of a message's text, with what `mentions list` and `show` need to point at it. */
export interface StoredMention {
  id: number
  kind: MentionKind
  value: string
  domain: string | null
  confidence: number
  status: MentionStatus
  /** Which text of the message: `text`, a file's `file_text`, or a voice note's `transcript`. */
  field: string
  /** Who linked or dismissed it: `owner`, an agent by name, `rules` for a value that already had an owner. */
  author: string | null
  /** The message it was found in: its chat's and its own id in the messenger. */
  chatId: string
  messageId: string
  sentAt: string
  /** What was written, read back from the message: never copied into the mention. */
  written: string
}

export const MENTION_STATUSES = ["found", "linked", "dismissed"] as const
export type MentionStatus = (typeof MENTION_STATUSES)[number]

/** The fields of `mentions list`; a bare word is a `value`. */
export const MENTION_QUERY = defineQuery({
  entity: "mention",
  backend: "sql",
  fields: [
    { name: "kind", type: "enum", values: [...MENTION_KINDS], operators: ["term"], example: "kind:phone" },
    { name: "status", type: "enum", values: [...MENTION_STATUSES], operators: ["term"], example: "status:found" },
    {
      name: "domain",
      type: "kw",
      operators: ["term", "phrase"],
      example: "domain:google.com",
      relation: "the site of a link or an address; docs.google.com means google.com",
    },
    {
      name: "value",
      type: "kw",
      operators: ["term", "phrase"],
      example: 'value:"8 900 000-00-01"',
      relation: "the value in the form it is stored: a phone as +7…, a lower-case address, a link without tracking",
    },
  ],
})

const COLUMNS: ColumnMap = {
  kind: { type: "enum", sql: "mn.kind" },
  status: { type: "enum", sql: "mn.status" },
  domain: { where: (node) => ({ sql: "mn.domain = ?", params: [siteOf(node.value.toLowerCase())] }) },
  value: { where: (node) => ({ sql: "mn.value = ?", params: [normalizedValue(node.value)] }) },
}

export interface MentionsState {
  /** Messages written or edited since their mentions were found. */
  pending: number
  /** When `mentions rebuild` last read every stored message; `null` before the first. */
  rebuiltAt: string | null
}

export interface MentionsRebuild {
  messages: number
  /** Files and voice notes of messages whose text was read. */
  attachments: number
  mentions: number
}

/** Mentions a store write finds before it commits: an older binary may have queued thousands. */
export const DRAIN_ON_WRITE = 500
const REBUILD_BATCH = 1000
const REBUILT_AT = "mentionsRebuiltAt"
const METHOD = "rules"

type Decision = { status: unknown; target_type: unknown; target_id: unknown; author: unknown }

/**
 * What a new mention starts as when nothing was decided where it was written: dismissed if its value was
 * dismissed anywhere, linked when the value already has an original — an identity with an owner for a phone
 * or an address, the stored document for a document id.
 */
const originalOf = (database: CacheDatabase) => {
  const dismissed = database.prepare(
    "SELECT status, NULL AS target_type, NULL AS target_id, author FROM mentions " +
      "WHERE kind = ? AND value = ? AND status = 'dismissed' LIMIT 1",
  )
  const identity = database.prepare(
    "SELECT 'linked' AS status, 'identity' AS target_type, i.id AS target_id, 'rules' AS author FROM identities i " +
      "JOIN identity_links l ON l.identity_id = i.id WHERE i.provider = ? AND i.external_id = ?",
  )
  const document = database.prepare(
    "SELECT 'linked' AS status, 'document' AS target_type, id AS target_id, 'rules' AS author FROM documents " +
      "WHERE json_extract(front_matter, '$.fileId') = ? AND deleted_at IS NULL ORDER BY id LIMIT 1",
  )
  return (kind: MentionKind, value: string): Decision | undefined =>
    (dismissed.get(kind, value) as Decision | undefined) ??
    ((kind === "phone" || kind === "email"
      ? identity.get(kind, value)
      : kind === "document"
        ? document.get(value)
        : undefined) as Decision | undefined)
}

/** Where mentions are read from: a message's own text, and the text of its files and voice notes. */
const SOURCES = {
  message: {
    count: "SELECT count(*) AS n FROM messages WHERE deleted_at IS NULL",
    page: "SELECT id, text, 'text' AS field FROM messages WHERE id > ? AND deleted_at IS NULL ORDER BY id LIMIT ?",
    one: "SELECT text, 'text' AS field FROM messages WHERE id = ? AND deleted_at IS NULL",
  },
  attachment: {
    count:
      "SELECT count(*) AS n FROM attachments a JOIN messages m ON m.id = a.attachable_id " +
      "WHERE a.attachable_type = 'message' AND a.text IS NOT NULL AND a.text <> '' AND m.deleted_at IS NULL",
    page:
      "SELECT a.id, a.text, CASE WHEN coalesce(a.extractor, '') LIKE 'speech:%' THEN 'transcript' ELSE 'file_text' END AS field " +
      "FROM attachments a JOIN messages m ON m.id = a.attachable_id WHERE a.id > ? AND a.attachable_type = 'message' " +
      "AND a.text IS NOT NULL AND a.text <> '' AND m.deleted_at IS NULL ORDER BY a.id LIMIT ?",
    one:
      "SELECT a.text, CASE WHEN coalesce(a.extractor, '') LIKE 'speech:%' THEN 'transcript' ELSE 'file_text' END AS field " +
      "FROM attachments a JOIN messages m ON m.id = a.attachable_id WHERE a.id = ? AND a.attachable_type = 'message' " +
      "AND a.text IS NOT NULL AND m.deleted_at IS NULL",
  },
} as const
type SourceType = keyof typeof SOURCES
const SOURCE_TYPES = Object.keys(SOURCES) as SourceType[]

const writer = (database: CacheDatabase, now: number, kinds: readonly MentionKind[] | undefined) => {
  const only = kinds ? ` AND kind IN (${kinds.map(() => "?").join(", ")})` : ""
  const decided = database.prepare(
    "SELECT kind, value, status, target_type, target_id, author FROM mentions " +
      `WHERE source_type = ? AND source_id = ? AND status <> 'found'${only}`,
  )
  const remove = database.prepare(`DELETE FROM mentions WHERE source_type = ? AND source_id = ?${only}`)
  const insert = database.prepare(
    "INSERT OR IGNORE INTO mentions (kind, source_type, source_id, source_field, start_offset, end_offset, value, " +
      "domain, method, version, confidence, status, target_type, target_id, author, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  const scope = kinds ?? []
  const original = originalOf(database)
  return (type: SourceType, pk: number, source: { text: string; field: string } | null): number => {
    const kept = new Map(decided.all(type, pk, ...scope).map((row) => [`${row.kind}\u0000${row.value}`, row] as const))
    remove.run(type, pk, ...scope)
    if (source === null) return 0
    let written = 0
    for (const found of findMentions(source.text)) {
      if (kinds && !kinds.includes(found.kind)) continue
      const decision = kept.get(`${found.kind}\u0000${found.value}`) ?? original(found.kind, found.value)
      written += Number(
        insert.run(
          found.kind,
          type,
          pk,
          source.field,
          found.start,
          found.end,
          found.value,
          found.domain,
          METHOD,
          MENTION_VERSIONS[found.kind],
          found.confidence,
          decision ? String(decision.status) : "found",
          decision?.target_type == null ? null : String(decision.target_type),
          decision?.target_id == null ? null : Number(decision.target_id),
          decision?.author == null ? null : String(decision.author),
          now,
          now,
        ).changes,
      )
    }
    return written
  }
}

const sourceOf = (row: Record<string, unknown> | undefined) =>
  row ? { text: String(row.text), field: String(row.field) } : null

/** Finds the mentions of the texts a store write queued, inside that write's transaction. */
export const drainMentions = (database: CacheDatabase, now: number, limit = DRAIN_ON_WRITE): number => {
  const queued = database
    .prepare("SELECT source_type, source_id FROM mention_pending ORDER BY source_type, source_id LIMIT ?")
    .all(limit)
    .map((row) => ({ type: String(row.source_type), pk: Number(row.source_id) }))
  if (queued.length === 0) return 0
  const write = writer(database, now, undefined)
  const read = Object.fromEntries(SOURCE_TYPES.map((type) => [type, database.prepare(SOURCES[type].one)]))
  const dequeue = database.prepare("DELETE FROM mention_pending WHERE source_type = ? AND source_id = ?")
  for (const { type, pk } of queued) {
    const known = SOURCE_TYPES.find((one) => one === type)
    if (known) write(known, pk, sourceOf(read[known]?.get(pk)))
    dequeue.run(type, pk)
  }
  return queued.length
}

/**
 * Finds the mentions of every stored message and attachment text again, in short write transactions. Decisions
 * stay: a linked or dismissed mention's status moves to the new row with the same kind and value. `kinds` redoes
 * only those.
 */
export const rebuildMentions = (
  database: CacheDatabase,
  {
    now,
    kinds,
    onBatch,
  }: { now: number; kinds?: readonly MentionKind[]; onBatch?: (done: number, total: number) => void },
): MentionsRebuild => {
  const total = SOURCE_TYPES.reduce((sum, type) => sum + Number(database.prepare(SOURCES[type].count).get()?.n), 0)
  const read: Record<SourceType, number> = { message: 0, attachment: 0 }
  let mentions = 0
  for (const type of SOURCE_TYPES) {
    const batch = database.prepare(SOURCES[type].page)
    let after = 0
    for (;;) {
      const rows = batch.all(after, REBUILD_BATCH)
      if (rows.length === 0) break
      database.exec("BEGIN IMMEDIATE")
      try {
        const write = writer(database, now, kinds)
        const dequeue = database.prepare("DELETE FROM mention_pending WHERE source_type = ? AND source_id = ?")
        for (const row of rows) {
          mentions += write(type, Number(row.id), sourceOf(row))
          if (!kinds) dequeue.run(type, Number(row.id))
        }
        database.exec("COMMIT")
      } catch (error) {
        database.exec("ROLLBACK")
        throw error
      }
      read[type] += rows.length
      after = Number(rows.at(-1)?.id)
      onBatch?.(read.message + read.attachment, total)
    }
  }
  if (!kinds) {
    database
      .prepare(
        "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at",
      )
      .run(REBUILT_AT, JSON.stringify(new Date(now).toISOString()), now)
  }
  return { messages: read.message, attachments: read.attachment, mentions }
}

export const mentionsState = (database: CacheDatabase): MentionsState => {
  const pending = Number(database.prepare("SELECT count(*) AS n FROM mention_pending").get()?.n)
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(REBUILT_AT)
  return { pending, rebuiltAt: row ? (JSON.parse(String(row.value)) as string) : null }
}

// A mention in a file or a voice note belongs to that attachment's message, and is listed with it.
const SELECT =
  "SELECT mn.id, mn.kind, mn.value, mn.domain, mn.confidence, mn.status, mn.author, mn.source_field, " +
  "mn.start_offset, mn.end_offset, CASE WHEN mn.source_type = 'attachment' THEN att.text ELSE m.text END AS text, " +
  "m.external_id AS message_id, m.sent_at, c.external_id AS chat_id FROM mentions mn " +
  "LEFT JOIN attachments att ON mn.source_type = 'attachment' AND att.id = mn.source_id AND att.attachable_type = 'message' " +
  "JOIN messages m ON m.id = CASE WHEN mn.source_type = 'attachment' THEN att.attachable_id ELSE mn.source_id END " +
  "AND m.deleted_at IS NULL JOIN chats c ON c.id = m.chat_id "

const stored = (row: Record<string, unknown>): StoredMention => ({
  id: Number(row.id),
  kind: String(row.kind) as MentionKind,
  value: String(row.value),
  domain: row.domain == null ? null : String(row.domain),
  confidence: Number(row.confidence),
  status: String(row.status) as MentionStatus,
  author: row.author == null ? null : String(row.author),
  field: String(row.source_field),
  chatId: String(row.chat_id),
  messageId: String(row.message_id),
  sentAt: new Date(Number(row.sent_at)).toISOString(),
  written: String(row.text).slice(Number(row.start_offset), Number(row.end_offset)),
})

/** One account's mentions that match the query, newest message first. `limit` absent is every row. */
export const listMentions = (
  database: CacheDatabase,
  accountPk: number,
  query: QueryAst | undefined,
  { limit, offset }: { limit?: number; offset: number },
): { items: StoredMention[]; hasMore: boolean } => {
  const where = ["m.account_id = ?"]
  const params: SqlValue[] = [accountPk]
  if (query) {
    const compiled = queryFilter(query, COLUMNS)
    if (compiled.sql) {
      where.push(`(${compiled.sql})`)
      params.push(...compiled.params)
    }
  }
  const rows = database
    .prepare(
      `${SELECT}WHERE ${where.join(" AND ")} ORDER BY m.sent_at DESC, m.id DESC, mn.start_offset, mn.id LIMIT ? OFFSET ?`,
    )
    .all(...params, limit === undefined ? -1 : limit + 1, offset)
  const items = rows.map(stored)
  if (limit === undefined || items.length <= limit) return { items, hasMore: false }
  return { items: items.slice(0, limit), hasMore: true }
}

/** One mention of the account, with the text around it and how many other places hold the same value. */
export const showMention = (
  database: CacheDatabase,
  accountPk: number,
  id: number,
  around = 80,
): (StoredMention & { before: string; after: string; sameValue: number }) | undefined => {
  const row = database.prepare(`${SELECT}WHERE mn.id = ? AND m.account_id = ?`).get(id, accountPk)
  if (!row) return undefined
  const text = String(row.text)
  const start = Number(row.start_offset)
  const end = Number(row.end_offset)
  const sameValue = Number(
    database
      .prepare("SELECT count(*) AS n FROM mentions WHERE kind = ? AND value = ? AND id <> ?")
      .get(String(row.kind), String(row.value), id)?.n,
  )
  return {
    ...stored(row),
    before: text.slice(Math.max(0, start - around), start),
    after: text.slice(end, end + around),
    sameValue,
  }
}

export interface MentionDecision {
  kind: MentionKind
  value: string
  status: MentionStatus
  /** What it now names, `identity:12` or `document:7`; `null` when dismissed. */
  target: string | null
  /** Every stored mention of this value that now carries the decision. */
  mentions: number
}

const mentionOfAccount = (database: CacheDatabase, accountPk: number, id: number) => {
  const row = database.prepare(`${SELECT}WHERE mn.id = ? AND m.account_id = ?`).get(id, accountPk)
  if (!row) throw new CliError("not_found", `no mention ${id} in this account`)
  return { kind: String(row.kind) as MentionKind, value: String(row.value) }
}

const decide = (
  database: CacheDatabase,
  { kind, value }: { kind: MentionKind; value: string },
  status: MentionStatus,
  target: { type: string; id: number } | null,
  by: string,
  now: number,
): MentionDecision => {
  const changed = database
    .prepare(
      "UPDATE mentions SET status = ?, target_type = ?, target_id = ?, author = ?, updated_at = ? " +
        "WHERE kind = ? AND value = ?",
    )
    .run(status, target?.type ?? null, target?.id ?? null, by, now, kind, value).changes
  return { kind, value, status, target: target ? `${target.type}:${target.id}` : null, mentions: Number(changed) }
}

/**
 * Says what a value is, for every place it is written. A phone or an address gets an identity of its own
 * (`provider` = the kind, the value as its id) owned by `personPk`; moving it to another person later is
 * that identity's link, not the mentions. A document id names the stored document.
 */
export const confirmMention = (
  context: StoreContext,
  accountPk: number,
  id: number,
  personPk: number | undefined,
  by: string,
): MentionDecision => {
  const { database } = context
  const mention = mentionOfAccount(database, accountPk, id)
  const now = context.now()
  if (mention.kind === "phone" || mention.kind === "email") {
    if (personPk === undefined)
      throw new CliError("validation_error", `a ${mention.kind} is confirmed to someone — name them as person:<uid>`)
    database
      .prepare(
        "INSERT INTO identities (provider, external_id, created_at, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (provider, external_id) DO NOTHING",
      )
      .run(mention.kind, mention.value, now, now)
    const identity = Number(
      database
        .prepare("SELECT id FROM identities WHERE provider = ? AND external_id = ?")
        .get(mention.kind, mention.value)?.id,
    )
    linkIdentityToPerson(context, identity, personPk, { method: "mention", by })
    return decide(database, mention, "linked", { type: "identity", id: identity }, by, now)
  }
  if (mention.kind === "document") {
    const document = database
      .prepare(
        "SELECT id FROM documents WHERE json_extract(front_matter, '$.fileId') = ? AND deleted_at IS NULL " +
          "ORDER BY id LIMIT 1",
      )
      .get(mention.value)
    if (!document)
      throw new CliError("not_found", "that document is not in the store yet — sync it from Drive, then confirm")
    return decide(database, mention, "linked", { type: "document", id: Number(document.id) }, by, now)
  }
  throw new CliError("validation_error", "a link has nothing to be linked to yet; reject it if it is not worth keeping")
}

/** Not a real mention, or not worth keeping: every place the value is written, now and on later syncs. */
export const rejectMention = (context: StoreContext, accountPk: number, id: number, by: string): MentionDecision =>
  decide(context.database, mentionOfAccount(context.database, accountPk, id), "dismissed", null, by, context.now())
