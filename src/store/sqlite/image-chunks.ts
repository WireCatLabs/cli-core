import { type SQL, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { dot } from "./vectors.js"

const IS_IMAGE = sql`(a.kind = 'photo' OR a.mime LIKE 'image/%')`

export interface NeighbourRow {
  sender: string | null
  text: string
  sentAt: number
}

/** An image attachment of a chat, what surrounds it, and the chunk it already has. */
export interface ImageInput {
  attachmentPk: number
  messageId: string
  name: string | null
  mime: string | null
  kind: string
  localPath: string | null
  caption: string
  sender: string | null
  chatTitle: string | null
  sentAt: number
  before: NeighbourRow[]
  after: NeighbourRow[]
  hash: string | null
}

const neighbours = (
  { orm }: StoreContext,
  chatKey: number,
  messagePk: number,
  sentAt: number,
  { messages, withinMs }: { messages: number; withinMs: number },
  side: "before" | "after",
): NeighbourRow[] =>
  orm.all<NeighbourRow>(
    sql`SELECT sender_name AS sender, text, sent_at AS sentAt FROM messages
      WHERE chat_id = ${chatKey} AND deleted_at IS NULL AND trim(text) <> '' AND id <> ${messagePk}
        AND ${
          side === "before"
            ? sql`(sent_at, id) < (${sentAt}, ${messagePk}) AND sent_at >= ${sentAt - withinMs}`
            : sql`(sent_at, id) > (${sentAt}, ${messagePk}) AND sent_at <= ${sentAt + withinMs}`
        }
      ORDER BY sent_at ${side === "before" ? sql`DESC` : sql`ASC`}, id ${side === "before" ? sql`DESC` : sql`ASC`}
      LIMIT ${messages}`,
  )

export const imagesOfChat = (
  context: StoreContext,
  chatKey: number,
  window: { messages: number; withinMs: number },
): ImageInput[] =>
  context.orm
    .all<{
      attachmentPk: number
      messagePk: number
      messageId: string
      name: string | null
      mime: string | null
      kind: string
      localPath: string | null
      caption: string
      sender: string | null
      chatTitle: string | null
      sentAt: number
      hash: string | null
    }>(
      sql`SELECT a.id AS attachmentPk, m.id AS messagePk, m.external_id AS messageId, a.name, a.mime, a.kind,
          a.local_path AS localPath, m.text AS caption, m.sender_name AS sender, ch.title AS chatTitle,
          m.sent_at AS sentAt, k.content_hash AS hash
        FROM attachments a JOIN messages m ON a.attachable_type = 'message' AND m.id = a.attachable_id
          JOIN chats ch ON ch.id = m.chat_id
          LEFT JOIN chunks k ON k.chunkable_type = 'image' AND k.chunkable_id = a.id AND k.position = 0
        WHERE m.chat_id = ${chatKey} AND m.deleted_at IS NULL AND ${IS_IMAGE}
        ORDER BY m.sent_at, m.id, a.position`,
    )
    .map(({ messagePk, ...image }) => ({
      ...image,
      before: neighbours(context, chatKey, messagePk, image.sentAt, window, "before"),
      after: neighbours(context, chatKey, messagePk, image.sentAt, window, "after"),
    }))

export interface ImageChunk {
  attachmentPk: number
  hash: string
  length: number
  occurredAt: number
}

/**
 * Makes these the chunks of their images, and drops the chunks of images that are gone or whose message was
 * deleted, with the vectors nothing else uses any more.
 */
export const saveImageChunks = (
  { orm, now }: StoreContext,
  accountPk: number,
  chatKey: number,
  chunks: ImageChunk[],
  keep: number[],
): void => {
  const at = now()
  const scope =
    orm.get<{ scope: string | null }>(sql`SELECT scope FROM accounts WHERE id = ${accountPk}`)?.scope ?? null
  const old = new Set<string>()
  const inChat = sql`chunkable_id IN (SELECT a.id FROM attachments a JOIN messages m
    ON a.attachable_type = 'message' AND m.id = a.attachable_id WHERE m.chat_id = ${chatKey})`
  const gone: SQL = sql`chunkable_type = 'image' AND (
    (${inChat} AND chunkable_id NOT IN (SELECT value FROM json_each(${JSON.stringify(keep)})))
    OR (account_id = ${accountPk} AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.id = chunkable_id)))`
  for (const { hash } of orm.all<{ hash: string }>(sql`SELECT content_hash AS hash FROM chunks WHERE ${gone}`))
    old.add(hash)
  orm.run(sql`DELETE FROM chunks WHERE ${gone}`)
  for (const { attachmentPk, hash, length, occurredAt } of chunks) {
    const held = orm.get<{ hash: string }>(
      sql`SELECT content_hash AS hash FROM chunks WHERE chunkable_type = 'image' AND chunkable_id = ${attachmentPk}`,
    )
    if (held?.hash === hash) continue
    if (held) old.add(held.hash)
    orm.run(sql`DELETE FROM chunks WHERE chunkable_type = 'image' AND chunkable_id = ${attachmentPk}`)
    orm.run(
      sql`INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, scope,
          account_id, occurred_at, created_at, updated_at)
        VALUES ('image', ${attachmentPk}, 0, 0, ${length}, ${hash}, ${scope}, ${accountPk}, ${occurredAt}, ${at}, ${at})`,
    )
  }
  for (const hash of old)
    orm.run(sql`DELETE FROM embeddings WHERE content_hash = ${hash}
      AND NOT EXISTS (SELECT 1 FROM chunks WHERE content_hash = ${hash})`)
}

/** The hashes among these that already have a vector of `model`. */
export const embeddedHashes = ({ orm }: StoreContext, model: string, hashes: string[]): Set<string> =>
  new Set(
    hashes.length === 0
      ? []
      : orm
          .all<{ hash: string }>(
            sql`SELECT content_hash AS hash FROM embeddings
              WHERE model = ${model} AND content_hash IN (SELECT value FROM json_each(${JSON.stringify(hashes)}))`,
          )
          .map(({ hash }) => hash),
  )

export interface NearestImage {
  chatId: string
  messageId: string
  score: number
}

const SCAN_PAGE = 5_000

/** The images of the account nearest to `query` by the vector of their context, best first. */
export const nearestImages = (
  { orm }: StoreContext,
  accountPk: number,
  {
    chatKey,
    model,
    since,
    limit,
    query,
  }: { chatKey?: number; model: string; since?: number; limit: number; query: Float32Array },
): NearestImage[] => {
  const found: NearestImage[] = []
  let after = 0
  for (;;) {
    const rows = orm.all<{ id: number; chatId: string; messageId: string; vector: Uint8Array }>(
      sql`SELECT k.id, ch.external_id AS chatId, m.external_id AS messageId, v.vector
        FROM chunks k CROSS JOIN attachments a ON a.id = k.chunkable_id AND a.attachable_type = 'message'
          JOIN messages m ON m.id = a.attachable_id AND m.deleted_at IS NULL
          JOIN chats ch ON ch.id = m.chat_id
          JOIN embeddings v ON v.model = ${model} AND v.content_hash = k.content_hash
        WHERE k.chunkable_type = 'image' AND ch.account_id = ${accountPk} AND k.id > ${after}
          ${chatKey === undefined ? sql`` : sql`AND m.chat_id = ${chatKey}`}
          ${since === undefined ? sql`` : sql`AND k.occurred_at >= ${since}`}
        ORDER BY k.id LIMIT ${SCAN_PAGE}`,
    )
    for (const row of rows) found.push({ chatId: row.chatId, messageId: row.messageId, score: dot(query, row.vector) })
    const last = rows.at(-1)
    if (!last || rows.length < SCAN_PAGE) break
    after = last.id
  }
  return found.sort((a, b) => b.score - a.score).slice(0, limit)
}
