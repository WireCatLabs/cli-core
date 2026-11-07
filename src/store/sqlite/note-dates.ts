import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"

/** `store.notes.dateFileNotes` for a folder's account row: only the time column moves, so it is not an edit. */
export const dateFileNotes = (
  database: CacheDatabase,
  folder: number,
  dates: { path: string; modifiedAt: string }[],
): number => {
  const fileAt = database.prepare(
    "SELECT id, document_id FROM files WHERE account_id = ? AND external_id = ? AND kind <> 'folder' AND deleted_at IS NULL",
  )
  const legacy = database.prepare(
    "SELECT id FROM documents WHERE account_id = ? AND external_id = ? AND deleted_at IS NULL",
  )
  const dateFile = database.prepare(
    "UPDATE files SET external_updated_at = ? WHERE id = ? AND external_updated_at IS NOT ?",
  )
  // Only the document's own file dates the document; a copy in another folder dates its file row.
  const dateDocument = database.prepare(
    "UPDATE documents SET external_updated_at = ? WHERE id = ? AND account_id = ? AND external_id = ? " +
      "AND external_updated_at IS NOT ?",
  )
  let changed = 0
  for (const { path, modifiedAt } of dates) {
    const time = Date.parse(modifiedAt)
    if (!Number.isFinite(time)) throw new CliError("validation_error", `${modifiedAt} is not a time`)
    const place = fileAt.get(folder, path)
    const id = place?.document_id ?? legacy.get(folder, path)?.id
    const file = place ? dateFile.run(time, Number(place.id), time).changes : 0
    const document = id == null ? 0 : dateDocument.run(time, Number(id), folder, path, time).changes
    if (file + document > 0) changed++
  }
  return changed
}
