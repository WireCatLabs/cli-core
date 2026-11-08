import type { CacheDatabase } from "../driver.js"
import { MAIL_PIECES } from "./email-index.js"
import { searchIndex } from "./vector-index.js"
import { dot } from "./vectors.js"

interface MailPieceFilter {
  accountId: number
  threadExternalId?: string | undefined
  since?: number | undefined
}

const MAIL_PIECE_ROWS = `SELECT p.id, p.content_hash AS hash, p.type, p.owner, p.position, p.email_id AS email, v.vector
    FROM ${MAIL_PIECES} JOIN embeddings v ON v.model = ? AND v.content_hash = p.content_hash
   WHERE p.account_id = ?
     AND (? IS NULL OR p.thread_id IN (SELECT id FROM email_threads WHERE account_id = p.account_id AND external_id = ?))
     AND (? IS NULL OR p.occurred_at >= ?)`

const pieceKey = (row: Record<string, unknown>) =>
  row.type === "email_thread" ? `${row.owner}:${row.position}` : `email:${row.email}`

const filterParams = (model: string, { accountId, threadExternalId, since }: MailPieceFilter) => [
  model,
  accountId,
  threadExternalId ?? null,
  threadExternalId ?? null,
  since ?? null,
  since ?? null,
]

const byScore = (best: Map<string, { score: number }>) =>
  [...best.entries()].map(([key, { score }]) => [key, score] as const).sort(([, a], [, b]) => b - a)

/** Every mail piece of the account scored against `query`: each thread piece or attachment keeps its best score. */
const scannedMailPieces = (database: CacheDatabase, model: string, query: Float32Array, filter: MailPieceFilter) => {
  const page = database.prepare(`${MAIL_PIECE_ROWS} AND p.id > ? ORDER BY p.id LIMIT 500`)
  const best = new Map<string, { score: number }>()
  for (let after = 0; ; ) {
    const rows = page.all(...filterParams(model, filter), after)
    for (const row of rows) {
      const score = dot(query, row.vector as Uint8Array)
      const key = pieceKey(row)
      if (score > (best.get(key)?.score ?? Number.NEGATIVE_INFINITY)) best.set(key, { score })
    }
    if (rows.length < 500) break
    after = Number(rows.at(-1)?.id)
  }
  return byScore(best)
}

/**
 * The best `depth` pieces of each kind by the model's vector index, or `undefined` when the index cannot answer and
 * the caller scans. Reading every mail vector of a large mailbox took most of a `search all`.
 */
const indexedMailPieces = (
  database: CacheDatabase,
  model: string,
  query: Float32Array,
  filter: MailPieceFilter,
  depth: number,
) => {
  const candidates = database.prepare(`${MAIL_PIECE_ROWS} AND p.id IN (SELECT value FROM json_each(?)) ORDER BY p.id`)
  const merged = new Map<string, { score: number }>()
  for (const kind of ["email_thread", "attachment", "email_enrichment"]) {
    const found = searchIndex(
      database,
      model,
      { kind, account: filter.accountId, ...(filter.since === undefined ? {} : { since: filter.since }) },
      query,
      depth,
      (near) => {
        const hashes = new Map(near.map(({ id, hash }) => [id, hash]))
        const best = new Map<string, { score: number; chunk: number }>()
        for (const row of candidates.all(...filterParams(model, filter), JSON.stringify([...hashes.keys()]))) {
          if (hashes.get(Number(row.id)) !== row.hash) continue
          const score = dot(query, row.vector as Uint8Array)
          const key = pieceKey(row)
          if (score > (best.get(key)?.score ?? Number.NEGATIVE_INFINITY))
            best.set(key, { score, chunk: Number(row.id) })
        }
        const results = byScore(best)
          .slice(0, depth)
          .map(([key]) => [key, best.get(key) as { score: number; chunk: number }] as const)
        return { results, best: results.map(([, { chunk }]) => chunk) }
      },
    )
    if (!found) return undefined
    for (const [key, held] of found) merged.set(key, held)
  }
  return byScore(merged)
}

/**
 * Each mail piece of the account (a thread's piece or an email's attachment) by its best score against `query`, best
 * first. Without a thread the index gives the best `depth` of each kind; a thread, or an index not ready, scans.
 */
export const nearestMailPieces = (
  database: CacheDatabase,
  model: string,
  query: Float32Array,
  filter: MailPieceFilter,
  depth: number,
): (readonly [string, number])[] =>
  (filter.threadExternalId === undefined ? indexedMailPieces(database, model, query, filter, depth) : undefined) ??
  scannedMailPieces(database, model, query, filter)
