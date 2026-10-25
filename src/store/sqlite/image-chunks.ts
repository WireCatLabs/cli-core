import { type SQL, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { searchIndex } from "./vector-index.js"
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
    (${inChat} AND position = 0 AND chunkable_id NOT IN (SELECT value FROM json_each(${JSON.stringify(keep)})))
    OR (account_id = ${accountPk} AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.id = chunkable_id)))`
  for (const { hash } of orm.all<{ hash: string }>(sql`SELECT content_hash AS hash FROM chunks WHERE ${gone}`))
    old.add(hash)
  orm.run(sql`DELETE FROM chunks WHERE ${gone}`)
  for (const { attachmentPk, hash, length, occurredAt } of chunks) {
    const held = orm.get<{ hash: string }>(
      sql`SELECT content_hash AS hash FROM chunks
        WHERE chunkable_type = 'image' AND chunkable_id = ${attachmentPk} AND position = 0`,
    )
    if (held?.hash === hash) continue
    if (held) old.add(held.hash)
    orm.run(sql`DELETE FROM chunks WHERE chunkable_type = 'image' AND chunkable_id = ${attachmentPk} AND position = 0`)
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

type ImageFilter = { chatKey?: number; model: string; since?: number; position: number }

/** The scan's rows: one page after `after`, or the `ids` the index picked. */
const imageRows = (
  { orm }: StoreContext,
  accountPk: number,
  { chatKey, model, since, position }: ImageFilter,
  rows: { after: number } | { ids: number[] },
) =>
  orm.all<{ id: number; hash: string; chatId: string; messageId: string; vector: Uint8Array }>(
    sql`SELECT k.id, k.content_hash AS hash, ch.external_id AS chatId, m.external_id AS messageId, v.vector
      FROM chunks k CROSS JOIN attachments a ON a.id = k.chunkable_id AND a.attachable_type = 'message'
        JOIN messages m ON m.id = a.attachable_id AND m.deleted_at IS NULL
        JOIN chats ch ON ch.id = m.chat_id
        JOIN embeddings v ON v.model = ${model} AND v.content_hash = k.content_hash
      WHERE k.chunkable_type = 'image' AND k.position = ${position} AND ch.account_id = ${accountPk}
        ${chatKey === undefined ? sql`AND ch.searchable = 1` : sql`AND m.chat_id = ${chatKey}`}
        ${since === undefined ? sql`` : sql`AND k.occurred_at >= ${since}`}
        ${
          "ids" in rows
            ? sql`AND k.id IN (SELECT value FROM json_each(${JSON.stringify(rows.ids)})) ORDER BY k.id`
            : sql`AND k.id > ${rows.after} ORDER BY k.id LIMIT ${SCAN_PAGE}`
        }`,
  )

/**
 * The images of the account nearest to `query` by the vector of `model`, best first. Position 0 of an image is
 * its context text, position 1 its picture (`PICTURE_POSITION`): a model's vectors only ever sit at one.
 */
export const nearestImages = (
  context: StoreContext,
  accountPk: number,
  {
    chatKey,
    model,
    since,
    limit,
    query,
    position = 0,
  }: { chatKey?: number; model: string; since?: number; limit: number; query: Float32Array; position?: number },
): NearestImage[] => {
  const filter: ImageFilter = {
    model,
    position,
    ...(chatKey === undefined ? {} : { chatKey }),
    ...(since === undefined ? {} : { since }),
  }
  const score = (row: { id: number; chatId: string; messageId: string; vector: Uint8Array }) => ({
    id: row.id,
    chatId: row.chatId,
    messageId: row.messageId,
    score: dot(query, row.vector),
  })
  // Stable, so equal scores keep the scan's order, by chunk id.
  const best = (found: (NearestImage & { id: number })[]) => found.sort((a, b) => b.score - a.score).slice(0, limit)
  const indexed = searchIndex(
    context.database,
    model,
    {
      kind: "image",
      account: accountPk,
      ...(chatKey === undefined ? {} : { chat: chatKey }),
      ...(since === undefined ? {} : { since }),
    },
    query,
    limit,
    (candidates) => {
      const hashes = new Map(candidates.map(({ id, hash }) => [id, hash]))
      const results = best(
        imageRows(context, accountPk, filter, { ids: [...hashes.keys()] })
          .filter((row) => hashes.get(row.id) === row.hash)
          .map(score),
      )
      return { results, best: results.map(({ id }) => id) }
    },
  )
  const plain = (found: (NearestImage & { id: number })[]) =>
    found.map(({ chatId, messageId, score }) => ({ chatId, messageId, score }))
  if (indexed) return plain(indexed)
  const found: (NearestImage & { id: number })[] = []
  let after = 0
  for (;;) {
    const rows = imageRows(context, accountPk, filter, { after })
    for (const row of rows) found.push(score(row))
    const last = rows.at(-1)
    if (!last || rows.length < SCAN_PAGE) break
    after = last.id
  }
  return plain(best(found))
}

/** An image's own vector is its chunk at this position; position 0 is the text around it. */
export const PICTURE_POSITION = 1

export interface PictureInput {
  attachmentPk: number
  chatId: string
  messageId: string
  /** The attachment's place in its message, from 0. */
  position: number
  name: string | null
  mime: string | null
  kind: string
  localPath: string | null
  sentAt: number
}

/** Live image attachments of the account that have no picture chunk yet, oldest id first, from `after`. */
export const picturesToEmbed = (
  { orm }: StoreContext,
  accountPk: number,
  { chatKey, after, limit }: { chatKey?: number; after?: number; limit: number },
): PictureInput[] =>
  orm.all<PictureInput>(
    sql`SELECT a.id AS attachmentPk, ch.external_id AS chatId, m.external_id AS messageId, a.position,
        a.name, a.mime, a.kind, a.local_path AS localPath, m.sent_at AS sentAt
      FROM attachments a JOIN messages m ON a.attachable_type = 'message' AND m.id = a.attachable_id
        JOIN chats ch ON ch.id = m.chat_id
      WHERE ch.account_id = ${accountPk} AND m.deleted_at IS NULL AND ${IS_IMAGE} AND a.id > ${after ?? 0}
        ${chatKey === undefined ? sql`` : sql`AND m.chat_id = ${chatKey}`}
        AND NOT EXISTS (SELECT 1 FROM chunks k WHERE k.chunkable_type = 'image' AND k.chunkable_id = a.id
          AND k.position = ${PICTURE_POSITION})
      ORDER BY a.id LIMIT ${limit}`,
  )

/** Makes each hash the picture chunk of its image; the vectors are saved apart, by `saveVectors`. */
export const savePictureChunks = (
  { orm, now }: StoreContext,
  accountPk: number,
  pictures: { attachmentPk: number; hash: string; bytes: number; occurredAt: number }[],
): void => {
  const at = now()
  const scope =
    orm.get<{ scope: string | null }>(sql`SELECT scope FROM accounts WHERE id = ${accountPk}`)?.scope ?? null
  // A deleted message keeps no trace of its picture, as it keeps none of its text.
  const gone = sql`chunkable_type = 'image' AND position = ${PICTURE_POSITION} AND account_id = ${accountPk}
    AND NOT EXISTS (SELECT 1 FROM attachments a JOIN messages m ON a.attachable_type = 'message'
      AND m.id = a.attachable_id WHERE a.id = chunkable_id AND m.deleted_at IS NULL)`
  const dropped = orm.all<{ hash: string }>(sql`SELECT content_hash AS hash FROM chunks WHERE ${gone}`)
  orm.run(sql`DELETE FROM chunks WHERE ${gone}`)
  for (const { hash } of dropped)
    orm.run(sql`DELETE FROM embeddings WHERE content_hash = ${hash}
      AND NOT EXISTS (SELECT 1 FROM chunks WHERE content_hash = ${hash})`)
  for (const { attachmentPk, hash, bytes, occurredAt } of pictures) {
    orm.run(
      sql`DELETE FROM chunks WHERE chunkable_type = 'image' AND chunkable_id = ${attachmentPk}
        AND position = ${PICTURE_POSITION}`,
    )
    orm.run(
      sql`INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, scope,
          account_id, occurred_at, created_at, updated_at)
        VALUES ('image', ${attachmentPk}, ${PICTURE_POSITION}, 0, ${bytes}, ${hash}, ${scope}, ${accountPk},
          ${occurredAt}, ${at}, ${at})`,
    )
  }
}
