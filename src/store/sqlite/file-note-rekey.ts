import type { CacheDatabase, SqlValue } from "../driver.js"
import { keepRevision, logDocumentChange } from "./document-history.js"
import { deleteDocumentRow } from "./evidence-signature.js"

type Row = Record<string, unknown>

const CONTENT = ["title", "body", "front_matter", "content_hash", "metadata", "language"]

const documentAt = (database: CacheDatabase, folder: number, path: string): Row | undefined => {
  const place = database
    .prepare("SELECT document_id FROM files WHERE account_id = ? AND external_id = ? AND kind <> 'folder'")
    .get(folder, path)
  return place?.document_id != null
    ? database.prepare("SELECT * FROM documents WHERE id = ?").get(Number(place.document_id))
    : database.prepare("SELECT * FROM documents WHERE account_id = ? AND external_id = ?").get(folder, path)
}

/**
 * Readies the document at `from` to move to `target`, the path of the id its source gave the file after a replace, so
 * it keeps its id and with it the tags, the notes about it and its links. A sync that ran between the replace and this
 * call took the document out at `from` and filed the file anew at `target`: the new text joins the old document, the
 * new one goes, and the old one is live again. False when nothing was ever at `from`.
 */
export const foldRekeyed = (database: CacheDatabase, folder: number, from: string, target: string, at: number) => {
  const old = documentAt(database, folder, from)
  if (!old) return false
  const id = Number(old.id)
  const filed = documentAt(database, folder, target)
  if (filed && Number(filed.id) !== id) {
    // A catalog entry not read yet has no text; the old document's stays until the next read.
    if (filed.body != null) {
      if ((old.body ?? "") !== "" && old.deleted_at == null) keepRevision(database, old, at)
      database
        .prepare(
          `UPDATE documents SET ${CONTENT.map((column) => `${column} = ?`).join(", ")}, revision = revision + 1, ` +
            "updated_at = ? WHERE id = ?",
        )
        .run(...(CONTENT.map((column) => filed[column] ?? null) as SqlValue[]), at, id)
    }
    deleteDocumentRow(database, Number(filed.id), at)
    database
      .prepare("DELETE FROM files WHERE account_id = ? AND external_id = ? AND kind <> 'folder'")
      .run(folder, target)
  }
  if (old.deleted_at != null) {
    database.prepare("UPDATE documents SET deleted_at = NULL, removal = NULL WHERE id = ?").run(id)
    database
      .prepare("UPDATE files SET deleted_at = NULL WHERE account_id = ? AND external_id = ? AND kind <> 'folder'")
      .run(folder, from)
    logDocumentChange(database, id, "restored", at)
  }
  return true
}
