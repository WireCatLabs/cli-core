import type { MeetingTranscriptDocumentStore } from "../../meetings/index.js"
import type { CacheDatabase } from "../driver.js"
import { driveDocumentOf, driveFileTarget } from "./files.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"

const TRANSCRIPT_ROLE = "transcript"

/**
 * The meeting's transcript is this Drive file: an `attached` link to the file's document, waiting by its Drive id when
 * Drive has not stored it yet. Drive's later import resolves it (`linkAttached`), so either order ends in one link.
 */
export const attachTranscriptDocument = (
  database: CacheDatabase,
  meetingId: number,
  fileId: string,
  now: number,
): void => {
  const file = fileId.trim()
  if (!file) return
  const target = driveFileTarget(file)
  const held = database
    .prepare(
      "SELECT id, to_id FROM links WHERE from_type = 'meeting' AND from_id = ? AND kind = 'attached' AND target_text = ?",
    )
    .get(meetingId, target)
  if (!held) {
    database
      .prepare(
        `INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, target_text, role, confirmed, author,
           created_at, updated_at) VALUES ('meeting', ?, 'document', ?, 'attached', 'meeting', ?, ?, 1, 'rule', ?, ?)`,
      )
      .run(meetingId, driveDocumentOf(database, file), target, TRANSCRIPT_ROLE, now, now)
    return
  }
  if (held.to_id != null) return
  const document = driveDocumentOf(database, file)
  if (document !== null)
    database.prepare("UPDATE links SET to_id = ?, updated_at = ? WHERE id = ?").run(document, now, Number(held.id))
}

export const meetingTranscriptDocumentsOver = ({ database }: StoreContext): MeetingTranscriptDocumentStore => ({
  async transcriptMeetings(documentIds) {
    if (!documentIds.length) return new Map()
    return read(database, () => {
      const rows = database
        .prepare(
          `SELECT l.to_id AS document_id, l.from_id AS meeting_id FROM links l JOIN meetings m ON m.id = l.from_id
           WHERE l.kind = 'attached' AND l.from_type = 'meeting' AND l.to_type = 'document' AND l.role = ?
             AND m.deleted_at IS NULL AND l.to_id IN (SELECT value FROM json_each(?)) ORDER BY l.id`,
        )
        .all(TRANSCRIPT_ROLE, JSON.stringify(documentIds))
      const found = new Map<number, number>()
      for (const row of rows)
        if (!found.has(Number(row.document_id))) found.set(Number(row.document_id), Number(row.meeting_id))
      return found
    })
  },
})
