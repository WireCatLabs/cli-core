import { CliError } from "@wirecat/cli-base"
import type { SqlValue } from "../driver.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"
import { ensureVectorIndex } from "./vector-index.js"
import { dot } from "./vectors.js"

/** A document's picture is one chunk of this type at position 0; its vector is the picture's, not text's. */
export const DOCUMENT_PICTURE = "document_picture"

const SCAN_PAGE = 5_000

const idOf = (ref: string): number => {
  const match = /^document:([1-9]\d*)$/.exec(ref)
  if (!match) throw new CliError("validation_error", `${ref} is not a document reference (document:<id>)`)
  return Number(match[1])
}

const purge = (database: StoreContext["database"], hashes: Iterable<string>) => {
  const drop = database.prepare(
    "DELETE FROM embeddings WHERE content_hash = ? AND NOT EXISTS (SELECT 1 FROM chunks WHERE content_hash = ?)",
  )
  for (const hash of hashes) drop.run(hash, hash)
}

/** Drops a document's picture chunk, and its vector when no other chunk shares the bytes. */
export const dropDocumentPicture = (database: StoreContext["database"], documentId: number): boolean => {
  const hashes = database
    .prepare("SELECT content_hash AS hash FROM chunks WHERE chunkable_type = ? AND chunkable_id = ?")
    .all(DOCUMENT_PICTURE, documentId)
    .map((row) => String(row.hash))
  database.prepare("DELETE FROM chunks WHERE chunkable_type = ? AND chunkable_id = ?").run(DOCUMENT_PICTURE, documentId)
  purge(database, hashes)
  return hashes.length > 0
}

export interface DocumentPictureStore {
  /** The sha256 of the bytes a document's picture vector of `model` was made from; none when it has no such vector. */
  pictureHash(ref: string, model: string): Promise<string | undefined>
  /** Makes `hash` the document's picture chunk and keeps its vector of `model`, replacing what was there. */
  savePicture(
    ref: string,
    picture: { model: string; dims: number; hash: string; bytes: number; vector: Float32Array },
  ): Promise<void>
  /** Drops the document's picture chunk and its vector; false when it had none. */
  removePicture(ref: string): Promise<boolean>
  /** Live documents nearest to `query` by their picture vector of `model`, best first. */
  nearestPictures(
    model: string,
    query: Float32Array,
    options: { limit: number; folderIds?: string[] },
  ): Promise<{ ref: string; score: number }[]>
}

export const documentPicturesOver = ({ database, now }: StoreContext): DocumentPictureStore => ({
  pictureHash: async (ref, model) => {
    const row = database
      .prepare(
        `SELECT k.content_hash AS hash FROM chunks k JOIN embeddings v ON v.model = ? AND v.content_hash = k.content_hash
          WHERE k.chunkable_type = ? AND k.chunkable_id = ? AND k.position = 0`,
      )
      .get(model, DOCUMENT_PICTURE, idOf(ref))
    return row === undefined ? undefined : String(row.hash)
  },

  savePicture: async (ref, { model, dims, hash, bytes, vector }) => {
    const id = idOf(ref)
    write(database, () => {
      const document = database
        .prepare(
          `SELECT d.account_id AS account, a.scope, d.updated_at AS at FROM documents d
            JOIN accounts a ON a.id = d.account_id WHERE d.id = ? AND d.deleted_at IS NULL`,
        )
        .get(id)
      if (!document) throw new CliError("not_found", `no document ${ref} in the local store`)
      const at = now()
      dropDocumentPicture(database, id)
      ensureVectorIndex(database, model, dims)
      database
        .prepare(
          `INSERT INTO embeddings (model, content_hash, dims, vector, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
        )
        .run(model, hash, dims, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), at, at)
      database
        .prepare(
          `INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, scope,
              account_id, occurred_at, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          DOCUMENT_PICTURE,
          id,
          bytes,
          hash,
          document.scope as SqlValue,
          document.account as SqlValue,
          document.at as SqlValue,
          at,
          at,
        )
    })
  },

  removePicture: async (ref) => write(database, () => dropDocumentPicture(database, idOf(ref))),

  nearestPictures: async (model, query, { limit, folderIds }) => {
    const folders = folderIds?.length ? JSON.stringify(folderIds) : null
    const page = database.prepare(
      `SELECT k.id, k.chunkable_id AS owner, v.vector
         FROM chunks k JOIN embeddings v ON v.model = ? AND v.content_hash = k.content_hash
        WHERE k.chunkable_type = ? AND k.position = 0 AND k.id > ?
          AND EXISTS (SELECT 1 FROM documents d WHERE d.id = k.chunkable_id AND d.deleted_at IS NULL
            AND coalesce(json_extract(d.metadata, '$.catalog.active'), 1) = 1
            AND (? IS NULL OR d.account_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))))
        ORDER BY k.id LIMIT ?`,
    )
    const found: { ref: string; score: number }[] = []
    let after = 0
    for (;;) {
      const rows = page.all(model, DOCUMENT_PICTURE, after, folders, folders, SCAN_PAGE)
      for (const row of rows) found.push({ ref: `document:${row.owner}`, score: dot(query, row.vector as Uint8Array) })
      const last = rows.at(-1)
      if (!last || rows.length < SCAN_PAGE) break
      after = Number(last.id)
    }
    return found.sort((a, b) => b.score - a.score).slice(0, limit)
  },
})
