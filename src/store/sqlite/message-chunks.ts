import { sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { dot } from "./vectors.js"

/** A live message with text, and the chunk and vector it already has, if any. */
export interface MessageToEmbed {
  messagePk: number
  text: string
  sentAt: number
  hash: string | null
  embedded: boolean
}

/** Live messages with text of the account, by pk after `after`; the caller compares hashes. */
export const messagesToEmbed = (
  { orm }: StoreContext,
  accountPk: number,
  { chatKey, model, after, limit }: { chatKey?: number; model: string; after: number; limit: number },
): MessageToEmbed[] =>
  orm
    .all<{ messagePk: number; text: string; sentAt: number; hash: string | null; embedded: number }>(
      sql`SELECT m.id AS messagePk, m.text, m.sent_at AS sentAt, k.content_hash AS hash,
          EXISTS (SELECT 1 FROM embeddings v WHERE v.model = ${model} AND v.content_hash = k.content_hash) AS embedded
        FROM messages m
          LEFT JOIN chunks k ON k.chunkable_type = 'message' AND k.chunkable_id = m.id AND k.position = 0
        WHERE m.account_id = ${accountPk} AND m.deleted_at IS NULL AND trim(m.text) <> '' AND m.id > ${after}
          ${chatKey === undefined ? sql`` : sql`AND m.chat_id = ${chatKey}`}
        ORDER BY m.id LIMIT ${limit}`,
    )
    .map((row) => ({ ...row, embedded: row.embedded === 1 }))

const dropUnshared = ({ orm }: StoreContext, hashes: Iterable<string>) => {
  for (const hash of hashes)
    orm.run(sql`DELETE FROM embeddings WHERE content_hash = ${hash}
      AND NOT EXISTS (SELECT 1 FROM chunks WHERE content_hash = ${hash})`)
}

/** Makes each hash its message's chunk; the vectors are saved apart, by `saveVectors`. */
export const saveMessageChunks = (
  context: StoreContext,
  accountPk: number,
  chunks: { messagePk: number; hash: string; length: number; occurredAt: number }[],
): void => {
  const { orm, now } = context
  const at = now()
  const scope =
    orm.get<{ scope: string | null }>(sql`SELECT scope FROM accounts WHERE id = ${accountPk}`)?.scope ?? null
  const old = new Set<string>()
  for (const { messagePk, hash, length, occurredAt } of chunks) {
    const held = orm.get<{ hash: string }>(
      sql`SELECT content_hash AS hash FROM chunks
        WHERE chunkable_type = 'message' AND chunkable_id = ${messagePk} AND position = 0`,
    )
    if (held?.hash === hash) continue
    if (held) old.add(held.hash)
    orm.run(sql`DELETE FROM chunks WHERE chunkable_type = 'message' AND chunkable_id = ${messagePk} AND position = 0`)
    orm.run(
      sql`INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, scope,
          account_id, occurred_at, created_at, updated_at)
        VALUES ('message', ${messagePk}, 0, 0, ${length}, ${hash}, ${scope}, ${accountPk}, ${occurredAt}, ${at}, ${at})`,
    )
  }
  dropUnshared(context, old)
}

/**
 * Drops the chunks of the account's messages that are gone, deleted or emptied, with the vectors nothing else
 * uses: no trigger does it for messages, and a deleted message keeps no trace of its text.
 */
export const dropGoneMessageChunks = (context: StoreContext, accountPk: number): number => {
  const gone = sql`chunkable_type = 'message' AND account_id = ${accountPk} AND NOT EXISTS (SELECT 1 FROM messages m
    WHERE m.id = chunkable_id AND m.deleted_at IS NULL AND trim(m.text) <> '')`
  const dropped = context.orm.all<{ hash: string }>(sql`SELECT content_hash AS hash FROM chunks WHERE ${gone}`)
  context.orm.run(sql`DELETE FROM chunks WHERE ${gone}`)
  dropUnshared(
    context,
    dropped.map(({ hash }) => hash),
  )
  return dropped.length
}

/** Whether any message of the account has a vector of `model`. */
export const hasMessageVectors = ({ orm }: StoreContext, accountPk: number, model: string): boolean =>
  orm.get(
    sql`SELECT 1 FROM chunks k JOIN embeddings v ON v.model = ${model} AND v.content_hash = k.content_hash
      WHERE k.chunkable_type = 'message' AND k.account_id = ${accountPk} LIMIT 1`,
  ) !== undefined

export interface NearestMessage {
  chatId: string
  messageId: string
  score: number
}

const SCAN_PAGE = 5_000

/** The account's live messages nearest to `query` by their vector of `model`, best first: a scan of every vector. */
export const nearestMessages = (
  { orm }: StoreContext,
  accountPk: number,
  {
    chatKey,
    model,
    since,
    before,
    limit,
    query,
  }: { chatKey?: number; model: string; since?: number; before?: number; limit: number; query: Float32Array },
): NearestMessage[] => {
  const found: NearestMessage[] = []
  let after = 0
  for (;;) {
    const rows = orm.all<{ id: number; chatId: string; messageId: string; vector: Uint8Array }>(
      sql`SELECT k.id, ch.external_id AS chatId, m.external_id AS messageId, v.vector
        FROM chunks k CROSS JOIN messages m ON m.id = k.chunkable_id AND m.deleted_at IS NULL
          JOIN chats ch ON ch.id = m.chat_id
          JOIN embeddings v ON v.model = ${model} AND v.content_hash = k.content_hash
        WHERE k.chunkable_type = 'message' AND k.position = 0 AND k.account_id = ${accountPk} AND k.id > ${after}
          ${chatKey === undefined ? sql`AND ch.searchable = 1` : sql`AND m.chat_id = ${chatKey}`}
          ${since === undefined ? sql`` : sql`AND m.sent_at >= ${since}`}
          ${before === undefined ? sql`` : sql`AND m.sent_at < ${before}`}
        ORDER BY k.id LIMIT ${SCAN_PAGE}`,
    )
    for (const row of rows) found.push({ chatId: row.chatId, messageId: row.messageId, score: dot(query, row.vector) })
    const last = rows.at(-1)
    if (!last || rows.length < SCAN_PAGE) break
    after = last.id
  }
  return found.sort((a, b) => b.score - a.score).slice(0, limit)
}
