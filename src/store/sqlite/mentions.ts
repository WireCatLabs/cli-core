import { findMentions, MENTION_VERSIONS, type MentionKind } from "../../domain/mentions.js"
import type { CacheDatabase } from "../driver.js"

export type MentionStatus = "found" | "linked" | "dismissed"

/** A stored mention of a message's text, with what `mentions list` and `show` need to point at it. */
export interface StoredMention {
  id: number
  kind: MentionKind
  value: string
  domain: string | null
  confidence: number
  status: MentionStatus
  /** The message it was found in: its chat's and its own id in the messenger. */
  chatId: string
  messageId: string
  sentAt: string
  /** What was written, read back from the message: never copied into the mention. */
  written: string
}

export interface MentionFilter {
  kind?: MentionKind
  status?: MentionStatus
  domain?: string
  value?: string
}

export interface MentionsState {
  /** Messages written or edited since their mentions were found. */
  pending: number
  /** When `mentions rebuild` last read every stored message; `null` before the first. */
  rebuiltAt: string | null
}

export interface MentionsRebuild {
  messages: number
  mentions: number
}

/** Mentions a store write finds before it commits: an older binary may have queued thousands. */
export const DRAIN_ON_WRITE = 500
const REBUILD_BATCH = 1000
const REBUILT_AT = "mentionsRebuiltAt"
const METHOD = "rules"

const writer = (database: CacheDatabase, now: number, kinds: readonly MentionKind[] | undefined) => {
  const only = kinds ? ` AND kind IN (${kinds.map(() => "?").join(", ")})` : ""
  const decided = database.prepare(
    "SELECT kind, value, status, target_type, target_id, author FROM mentions " +
      `WHERE source_type = 'message' AND source_id = ? AND status <> 'found'${only}`,
  )
  const remove = database.prepare(`DELETE FROM mentions WHERE source_type = 'message' AND source_id = ?${only}`)
  const insert = database.prepare(
    "INSERT OR IGNORE INTO mentions (kind, source_type, source_id, source_field, start_offset, end_offset, value, " +
      "domain, method, version, confidence, status, target_type, target_id, author, created_at, updated_at) " +
      "VALUES (?, 'message', ?, 'text', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  const scope = kinds ?? []
  return (messagePk: number, text: string | null): number => {
    const kept = new Map(decided.all(messagePk, ...scope).map((row) => [`${row.kind}\u0000${row.value}`, row] as const))
    remove.run(messagePk, ...scope)
    if (text === null) return 0
    let written = 0
    for (const found of findMentions(text)) {
      if (kinds && !kinds.includes(found.kind)) continue
      const decision = kept.get(`${found.kind}\u0000${found.value}`)
      written += Number(
        insert.run(
          found.kind,
          messagePk,
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

const liveText = (database: CacheDatabase) => {
  const read = database.prepare("SELECT text FROM messages WHERE id = ? AND deleted_at IS NULL")
  return (pk: number): string | null => {
    const row = read.get(pk)
    return row ? String(row.text) : null
  }
}

/** Finds the mentions of the messages a store write queued, inside that write's transaction. */
export const drainMentions = (database: CacheDatabase, now: number, limit = DRAIN_ON_WRITE): number => {
  const queued = database
    .prepare("SELECT source_id FROM mention_pending WHERE source_type = 'message' ORDER BY source_id LIMIT ?")
    .all(limit)
    .map((row) => Number(row.source_id))
  if (queued.length === 0) return 0
  const write = writer(database, now, undefined)
  const text = liveText(database)
  const dequeue = database.prepare("DELETE FROM mention_pending WHERE source_type = 'message' AND source_id = ?")
  for (const pk of queued) {
    write(pk, text(pk))
    dequeue.run(pk)
  }
  return queued.length
}

/**
 * Finds the mentions of every stored message again, in short write transactions. Decisions stay: a linked or
 * dismissed mention's status moves to the new row with the same kind and value. `kinds` redoes only those.
 */
export const rebuildMentions = (
  database: CacheDatabase,
  {
    now,
    kinds,
    onBatch,
  }: { now: number; kinds?: readonly MentionKind[]; onBatch?: (done: number, total: number) => void },
): MentionsRebuild => {
  const total = Number(database.prepare("SELECT count(*) AS n FROM messages WHERE deleted_at IS NULL").get()?.n)
  const batch = database.prepare(
    "SELECT id, text FROM messages WHERE id > ? AND deleted_at IS NULL ORDER BY id LIMIT ?",
  )
  let after = 0
  let messages = 0
  let mentions = 0
  for (;;) {
    const rows = batch.all(after, REBUILD_BATCH)
    if (rows.length === 0) break
    database.exec("BEGIN IMMEDIATE")
    try {
      const write = writer(database, now, kinds)
      const dequeue = database.prepare("DELETE FROM mention_pending WHERE source_type = 'message' AND source_id = ?")
      for (const row of rows) {
        mentions += write(Number(row.id), String(row.text))
        if (!kinds) dequeue.run(Number(row.id))
      }
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
    messages += rows.length
    after = Number(rows.at(-1)?.id)
    onBatch?.(messages, total)
  }
  if (!kinds) {
    database
      .prepare(
        "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at",
      )
      .run(REBUILT_AT, JSON.stringify(new Date(now).toISOString()), now)
  }
  return { messages, mentions }
}

export const mentionsState = (database: CacheDatabase): MentionsState => {
  const pending = Number(database.prepare("SELECT count(*) AS n FROM mention_pending").get()?.n)
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(REBUILT_AT)
  return { pending, rebuiltAt: row ? (JSON.parse(String(row.value)) as string) : null }
}

const SELECT =
  "SELECT mn.id, mn.kind, mn.value, mn.domain, mn.confidence, mn.status, mn.start_offset, mn.end_offset, " +
  "m.text, m.external_id AS message_id, m.sent_at, c.external_id AS chat_id " +
  "FROM mentions mn JOIN messages m ON mn.source_type = 'message' AND m.id = mn.source_id AND m.deleted_at IS NULL " +
  "JOIN chats c ON c.id = m.chat_id "

const stored = (row: Record<string, unknown>): StoredMention => ({
  id: Number(row.id),
  kind: String(row.kind) as MentionKind,
  value: String(row.value),
  domain: row.domain == null ? null : String(row.domain),
  confidence: Number(row.confidence),
  status: String(row.status) as MentionStatus,
  chatId: String(row.chat_id),
  messageId: String(row.message_id),
  sentAt: new Date(Number(row.sent_at)).toISOString(),
  written: String(row.text).slice(Number(row.start_offset), Number(row.end_offset)),
})

/** One account's mentions, newest message first. `limit` absent is every row. */
export const listMentions = (
  database: CacheDatabase,
  accountPk: number,
  filter: MentionFilter,
  { limit, offset }: { limit?: number; offset: number },
): { items: StoredMention[]; hasMore: boolean } => {
  const where = ["m.account_id = ?"]
  const params: (string | number)[] = [accountPk]
  for (const [column, value] of [
    ["mn.kind", filter.kind],
    ["mn.status", filter.status],
    ["mn.domain", filter.domain],
    ["mn.value", filter.value],
  ] as const) {
    if (value === undefined) continue
    where.push(`${column} = ?`)
    params.push(value)
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
