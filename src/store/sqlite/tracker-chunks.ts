import { CHUNK_CHARS, chunkHash, splitText } from "../../conversations/chunks.js"
import { type CacheDatabase, isQueryOnly } from "../driver.js"
import { noteIndexText } from "./index-text.js"
import { write } from "./transaction.js"
import { dropUnusedVectors, searchIndex } from "./vector-index.js"
import { dot } from "./vectors.js"

/** `chunks.chunkable_type` of an issue's, a project's or a comment's pieces; `chunkable_id` is `tracker_items.id`. */
export const TRACKER_CHUNK = "tracker_item"

/** The kinds searched by meaning; teams, users, states and labels are names, found by their words. */
const CHUNKED = new Set(["issue", "project", "comment"])
const CHUNKED_SQL = "('issue', 'project', 'comment')"

export const isChunkedTrackerKind = (kind: string): boolean => CHUNKED.has(kind)

/**
 * A comment with fewer characters than this, spaces and line breaks around it aside, is not embedded: `LGTM`, `+1`,
 * «Спасибо» say nothing alone, and with their issue in front each became a near copy of the issue that filled the
 * first results (cli-testing performance/search/tracker-meaning). Its words still find it.
 */
export const SHORTEST_EMBEDDED_COMMENT = 16
/** What the chunks hold; raised with each change to `textOf`, so a store cut before is cut again once. */
const CUT = "comments after their issue's key and title"
const CUT_SETTING = "tracker_chunks_cut"
const RECUT_AFTER = "tracker_chunks_recut_after"

// SQLite's `trim` and `length` take spaces and code points; JavaScript's `trim` takes more, and `length` counts halves.
const EDGE = /^[ \t\n\r]+|[ \t\n\r]+$/gu
const embeddedComment = (body: string | null): boolean =>
  [...(body ?? "").replace(EDGE, "")].length >= SHORTEST_EMBEDDED_COMMENT
const EDGE_SQL = "' ' || char(9, 10, 13)"
const EMBEDDED_COMMENT_SQL = `length(trim(coalesce(t.body, ''), ${EDGE_SQL})) >= ${SHORTEST_EMBEDDED_COMMENT}`

type Issue = { key: string | null; title: string }

/**
 * What an item is embedded as, from its stored columns: chunk offsets point into it. A comment's issue goes in front:
 * "it works now" means something only beside the issue it answers.
 */
const textOf = (kind: string, title: string, body: string | null, issue: Issue | undefined): string => {
  if (kind !== "comment") return noteIndexText(title, body ?? "")
  if (!embeddedComment(body)) return ""
  const heading = issue ? [issue.key, issue.title].filter(Boolean).join(" ") : ""
  return heading ? `${heading}\n\n${body}` : (body ?? "")
}

/** The issue a comment is on, as its account holds it; a deleted one still names what the comment answered. */
const issueOf = (database: CacheDatabase) => {
  const read = database.prepare(
    "SELECT title, json_extract(data, '$.key') AS key FROM tracker_items " +
      "WHERE account_id = ? AND kind = 'issue' AND external_id = ?",
  )
  return (kind: string, accountId: number, parent: string | null): Issue | undefined => {
    if (kind !== "comment" || parent === null) return undefined
    const row = read.get(accountId, parent)
    return row ? { key: row.key == null ? null : String(row.key), title: String(row.title) } : undefined
  }
}

const piecesOf = (text: string) => {
  if (!text.trim()) return []
  return splitText(text, CHUNK_CHARS).map(({ start, end }) => ({ start, end, hash: chunkHash(text.slice(start, end)) }))
}

export interface ChunkedItem {
  id: number
  accountId: number
  kind: string
  title: string
  body: string | null
  /** A comment's issue, by the tracker's id. */
  parent: string | null
  occurredAt: number
  scope: string | null
}

/**
 * Inside the caller's write: makes each item's chunks its text's, and answers the hashes it released and how many
 * chunks it wrote, or `undefined` when they already were. The caller drops the vectors of those once every new chunk is in, so a text another item or
 * account still holds keeps its vector.
 */
export const trackerChunkWriter = (database: CacheDatabase) => {
  const held = database.prepare(
    `SELECT start_offset AS start, end_offset AS end, content_hash AS hash FROM chunks
      WHERE chunkable_type = '${TRACKER_CHUNK}' AND chunkable_id = ? ORDER BY position`,
  )
  const drop = database.prepare(`DELETE FROM chunks WHERE chunkable_type = '${TRACKER_CHUNK}' AND chunkable_id = ?`)
  const insert = database.prepare(
    "INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, scope, " +
      `account_id, occurred_at, created_at, updated_at) VALUES ('${TRACKER_CHUNK}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const issue = issueOf(database)
  return (item: ChunkedItem, at: number): { released: string[]; written: number } | undefined => {
    if (!CHUNKED.has(item.kind)) return undefined
    const wanted = piecesOf(textOf(item.kind, item.title, item.body, issue(item.kind, item.accountId, item.parent)))
    const before = held.all(item.id).map((row) => ({
      start: Number(row.start),
      end: Number(row.end),
      hash: String(row.hash),
    }))
    const same =
      before.length === wanted.length &&
      before.every((one, at) => {
        const other = wanted[at]
        return other !== undefined && one.start === other.start && one.end === other.end && one.hash === other.hash
      })
    if (same) return undefined
    drop.run(item.id)
    wanted.forEach(({ start, end, hash }, position) => {
      insert.run(item.id, position, start, end, hash, item.scope, item.accountId, item.occurredAt, at, at)
    })
    return { released: before.map(({ hash }) => hash), written: wanted.length }
  }
}

/** Inside the caller's write: drops the chunks of these items and the vectors no other chunk holds. */
export const dropTrackerChunks = (database: CacheDatabase, ids: readonly number[]): void => {
  if (!ids.length) return
  const released = database
    .prepare(
      `DELETE FROM chunks WHERE chunkable_type = '${TRACKER_CHUNK}' AND chunkable_id IN (SELECT value FROM json_each(?))
        RETURNING content_hash AS hash`,
    )
    .all(JSON.stringify(ids))
    .map(({ hash }) => String(hash))
  dropUnusedVectors(database, released)
}

const BACKFILL = 200

const chunkedOf = (row: Record<string, unknown>): ChunkedItem => ({
  id: Number(row.id),
  accountId: Number(row.account_id),
  kind: String(row.kind),
  title: String(row.title),
  body: row.body == null ? null : String(row.body),
  parent: row.parent_id == null ? null : String(row.parent_id),
  occurredAt: Number(row.at),
  scope: row.scope == null ? null : String(row.scope),
})

const ITEM_COLUMNS =
  "t.id, t.account_id, t.kind, t.title, t.body, t.parent_id, coalesce(t.source_updated_at, t.synced_at) AS at, a.scope"

const setting = (database: CacheDatabase, key: string) =>
  database.prepare("SELECT value FROM store_settings WHERE key = ?").get(key)?.value

/**
 * Drops the chunks of items the tracker no longer lists, cuts the comments of a store cut before the current `CUT`
 * again, then cuts the chunks of live items that have none: those saved before tracker items were searched by meaning.
 * Short write transactions, `until` asked before each, so a deadline stops it with `left` and the next run goes on
 * from there; nothing under a read-only store.
 */
export const refreshTrackerChunks = (
  database: CacheDatabase,
  now: number,
  until: () => boolean = () => false,
): { dropped: number; added: number; left: boolean } => {
  if (isQueryOnly(database)) return { dropped: 0, added: 0, left: false }
  const dropped = write(database, () => {
    const gone = database
      .prepare(
        `DELETE FROM chunks WHERE chunkable_type = '${TRACKER_CHUNK}' AND NOT EXISTS (SELECT 1 FROM tracker_items t
          WHERE t.id = chunkable_id AND t.deleted_at IS NULL AND t.kind IN ${CHUNKED_SQL})
          RETURNING content_hash AS hash`,
      )
      .all()
      .map(({ hash }) => String(hash))
    dropUnusedVectors(database, gone)
    return gone.length
  })
  const chunk = trackerChunkWriter(database)
  let added = 0
  // A store with no tracker chunks has nothing cut the old way: every chunk it gets is cut the current way.
  if (
    setting(database, CUT_SETTING) !== CUT &&
    !database.prepare(`SELECT 1 FROM chunks WHERE chunkable_type = '${TRACKER_CHUNK}' LIMIT 1`).get()
  )
    write(database, () =>
      database
        .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
        .run(CUT_SETTING, CUT, now),
    )
  if (setting(database, CUT_SETTING) !== CUT) {
    const comments = database.prepare(
      `SELECT ${ITEM_COLUMNS} FROM tracker_items t JOIN accounts a ON a.id = t.account_id
        WHERE t.id > ? AND t.kind = 'comment' AND t.deleted_at IS NULL ORDER BY t.id LIMIT ?`,
    )
    const mark = database.prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
    let after = Number(setting(database, RECUT_AFTER) ?? 0)
    for (;;) {
      if (until()) return { dropped, added, left: true }
      const rows = write(database, () => {
        const found = comments.all(after, BACKFILL)
        const released: string[] = []
        for (const row of found) {
          const freed = chunk(chunkedOf(row), now)
          if (freed?.written) added += 1
          for (const hash of freed?.released ?? []) released.push(hash)
        }
        dropUnusedVectors(database, released)
        const last = found.at(-1)
        if (found.length < BACKFILL) {
          database.prepare("DELETE FROM store_settings WHERE key = ?").run(RECUT_AFTER)
          mark.run(CUT_SETTING, CUT, now)
        } else if (last) mark.run(RECUT_AFTER, String(last.id), now)
        return found
      })
      const last = rows.at(-1)
      if (!last || rows.length < BACKFILL) break
      after = Number(last.id)
    }
  }
  // An item with no text never gets a chunk: reading it again at every embed would find nothing.
  const page = database.prepare(
    `SELECT ${ITEM_COLUMNS} FROM tracker_items t JOIN accounts a ON a.id = t.account_id
      WHERE t.id > ? AND t.deleted_at IS NULL AND t.kind IN ${CHUNKED_SQL}
        AND CASE t.kind WHEN 'comment' THEN ${EMBEDDED_COMMENT_SQL}
          ELSE trim(t.title || coalesce(t.body, '')) <> '' END
        AND NOT EXISTS (SELECT 1 FROM chunks k WHERE k.chunkable_type = '${TRACKER_CHUNK}' AND k.chunkable_id = t.id)
      ORDER BY t.id LIMIT ?`,
  )
  let after = 0
  for (;;) {
    if (until()) return { dropped, added, left: page.all(after, 1).length > 0 }
    const rows = write(database, () => {
      const found = page.all(after, BACKFILL)
      for (const row of found) if (chunk(chunkedOf(row), now)?.written) added += 1
      return found
    })
    const last = rows.at(-1)
    if (!last || rows.length < BACKFILL) break
    after = Number(last.id)
  }
  return { dropped, added, left: false }
}

const LIVE =
  `k.chunkable_type = '${TRACKER_CHUNK}' AND EXISTS (SELECT 1 FROM tracker_items t WHERE t.id = k.chunkable_id ` +
  "AND t.deleted_at IS NULL)"

const UNEMBEDDED = `${LIVE} AND NOT EXISTS (SELECT 1 FROM embeddings v WHERE v.model = ? AND v.content_hash = k.content_hash)`

export const trackerChunksLeft = (database: CacheDatabase, model: string): number =>
  Number(
    database.prepare(`SELECT count(DISTINCT k.content_hash) AS n FROM chunks k WHERE ${UNEMBEDDED}`).get(model)?.n ?? 0,
  )

/**
 * Live items' chunks with no vector of `model`, by hash from `after`, each with its text cut again. A chunk whose text
 * no longer hashes to its hash was cut another way, by an older build sharing the store: its item is cut again (never
 * under a read-only store) and the chunk left out, so no vector is made of other text than its hash names.
 */
export const trackerChunksToEmbed = (
  database: CacheDatabase,
  model: string,
  { after, limit }: { after?: string; limit: number },
  now: number = Date.now(),
): { hash: string; text: string }[] => {
  const item = database.prepare(
    `SELECT ${ITEM_COLUMNS} FROM tracker_items t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`,
  )
  const issue = issueOf(database)
  const stale: Record<string, unknown>[] = []
  const found = database
    .prepare(
      `SELECT k.content_hash AS hash, min(k.chunkable_id) AS owner, k.start_offset AS start, k.end_offset AS end
         FROM chunks k WHERE k.content_hash > ? AND ${UNEMBEDDED}
        GROUP BY k.content_hash ORDER BY k.content_hash LIMIT ?`,
    )
    .all(after ?? "", model, limit)
    .flatMap((row) => {
      const owner = item.get(Number(row.owner))
      if (!owner) return []
      const { kind, title, body, accountId, parent } = chunkedOf(owner)
      const text = textOf(kind, title, body, issue(kind, accountId, parent)).slice(Number(row.start), Number(row.end))
      if (chunkHash(text) === String(row.hash)) return [{ hash: String(row.hash), text }]
      stale.push(owner)
      return []
    })
  if (stale.length && !isQueryOnly(database))
    write(database, () => {
      const chunk = trackerChunkWriter(database)
      const released: string[] = []
      for (const owner of stale) for (const hash of chunk(chunkedOf(owner), now)?.released ?? []) released.push(hash)
      dropUnusedVectors(database, released)
    })
  return found
}

export const trackerEmbedded = (database: CacheDatabase, model: string, accountIds: readonly number[]): boolean =>
  accountIds.length > 0 &&
  database
    .prepare(
      `SELECT 1 FROM chunks k JOIN embeddings v ON v.model = ? AND v.content_hash = k.content_hash
        WHERE ${LIVE} AND k.account_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
    )
    .get(model, JSON.stringify(accountIds)) !== undefined

const SCAN_PAGE = 5_000

interface Best {
  owner: number
  chunk: number
  score: number
}

/** Each item scored by its best chunk, best first; equal scores by item, so the index and the scan agree. */
const ranked = (best: Map<number, Best>, limit: number) =>
  [...best.values()].sort((a, b) => b.score - a.score || a.owner - b.owner).slice(0, limit)

/**
 * The account's live items nearest to `query` by their best chunk's vector of `model`, archived ones too: by the
 * model's vector index, or by a scan of the account's chunks while it has none.
 */
export const nearestTrackerItems = (
  database: CacheDatabase,
  model: string,
  query: Float32Array,
  { accountId, limit }: { accountId: number; limit: number },
): { owner: number; score: number }[] => {
  const columns = `k.id, k.chunkable_id AS owner, k.content_hash AS hash, v.vector
    FROM chunks k JOIN embeddings v ON v.model = ? AND v.content_hash = k.content_hash
    WHERE ${LIVE} AND k.account_id = ?`
  const keep = (best: Map<number, Best>, row: Record<string, unknown>) => {
    const score = dot(query, row.vector as Uint8Array)
    const owner = Number(row.owner)
    if (score > (best.get(owner)?.score ?? Number.NEGATIVE_INFINITY))
      best.set(owner, { owner, chunk: Number(row.id), score })
  }
  const candidates = database.prepare(`SELECT ${columns} AND k.id IN (SELECT value FROM json_each(?)) ORDER BY k.id`)
  const indexed = searchIndex(database, model, { kind: TRACKER_CHUNK, account: accountId }, query, limit, (near) => {
    const hashes = new Map(near.map(({ id, hash }) => [id, hash]))
    const best = new Map<number, Best>()
    for (const row of candidates.all(model, accountId, JSON.stringify([...hashes.keys()])))
      if (hashes.get(Number(row.id)) === row.hash) keep(best, row)
    const results = ranked(best, limit)
    return { results, best: results.map(({ chunk }) => chunk) }
  })
  const plain = (found: Best[]) => found.map(({ owner, score }) => ({ owner, score }))
  if (indexed) return plain(indexed)
  const page = database.prepare(`SELECT ${columns} AND k.id > ? ORDER BY k.id LIMIT ?`)
  const best = new Map<number, Best>()
  let after = 0
  for (;;) {
    const rows = page.all(model, accountId, after, SCAN_PAGE)
    for (const row of rows) keep(best, row)
    const last = rows.at(-1)
    if (!last || rows.length < SCAN_PAGE) break
    after = Number(last.id)
  }
  return plain(ranked(best, limit))
}
