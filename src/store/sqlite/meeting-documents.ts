import {
  type DocumentMeeting,
  MEETING_DOCUMENT_ROLES,
  type MeetingDocument,
  type MeetingDocumentInput,
  type MeetingDocumentRole,
  type MeetingTranscriptDocumentStore,
} from "../../meetings/index.js"
import type { CacheDatabase } from "../driver.js"
import { fromJson, int, str } from "./events.js"
import { driveDocumentOf, driveFileTarget } from "./files.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"

const TRANSCRIPT_ROLE = "transcript"

const roleOf = (value: unknown): MeetingDocumentRole | undefined =>
  MEETING_DOCUMENT_ROLES.find((role) => role === value)

/**
 * The meeting's Drive file as an `attached` link to the file's document, waiting by its Drive id when Drive has not
 * stored it yet. Drive's later import resolves it (`linkAttached`), so either order ends in one link.
 *
 * Metadata tells who named the file: `{ listed: true, title? }` the source's list (`MeetingSave.documents`), or
 * `{ source }` a transcript version (`TranscriptInput.driveFileId`). A listing wins: it sets the role and title, and a
 * transcript version never changes a listed link.
 */
const attach = (
  database: CacheDatabase,
  meetingId: number,
  fileId: string,
  role: MeetingDocumentRole,
  metadata: string,
  listed: boolean,
  now: number,
): void => {
  const target = driveFileTarget(fileId)
  const held = database
    .prepare(
      "SELECT id, to_id, role, metadata FROM links WHERE from_type = 'meeting' AND from_id = ? AND kind = 'attached' " +
        "AND target_text = ?",
    )
    .get(meetingId, target)
  if (!held) {
    database
      .prepare(
        `INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, target_text, role, metadata, confirmed,
           author, created_at, updated_at) VALUES ('meeting', ?, 'document', ?, 'attached', 'meeting', ?, ?, ?, 1, 'rule',
           ?, ?)`,
      )
      .run(meetingId, driveDocumentOf(database, fileId), target, role, metadata, now, now)
    return
  }
  const document = held.to_id == null ? driveDocumentOf(database, fileId) : int(held.to_id)
  const nextRole = listed ? role : str(held.role)
  const nextMetadata = listed ? metadata : str(held.metadata)
  database
    .prepare(
      "UPDATE links SET to_id = ?, role = ?, metadata = ?, updated_at = ? WHERE id = ? " +
        "AND (to_id IS NOT ? OR role IS NOT ? OR metadata IS NOT ?)",
    )
    .run(document, nextRole, nextMetadata, now, Number(held.id), document, nextRole, nextMetadata)
}

/** A file the meeting's source listed. Listed links only grow: a file left out of a later list stays linked. */
export const attachListedDocument = (
  database: CacheDatabase,
  meetingId: number,
  { fileId, role, title }: MeetingDocumentInput,
  now: number,
): void => {
  const file = fileId.trim()
  if (file)
    attach(database, meetingId, file, role, JSON.stringify({ listed: true, ...(title ? { title } : {}) }), true, now)
}

/**
 * The file one transcript source saved its transcript as. A new version (`replaces`) drops the links an earlier
 * version of the same source named, never a listed link or another source's; a replay of an old version keeps them.
 */
export const attachTranscriptFile = (
  database: CacheDatabase,
  meetingId: number,
  fileId: string,
  source: string,
  now: number,
  replaces: boolean,
): void => {
  const file = fileId.trim()
  if (!file) return
  if (replaces)
    database
      .prepare(
        "DELETE FROM links WHERE from_type = 'meeting' AND from_id = ? AND kind = 'attached' AND role = ? " +
          "AND target_text <> ? AND json_extract(metadata, '$.source') = ? AND json_extract(metadata, '$.listed') IS NULL",
      )
      .run(meetingId, TRANSCRIPT_ROLE, driveFileTarget(file), source)
  attach(database, meetingId, file, TRANSCRIPT_ROLE, JSON.stringify({ source }), false, now)
}

/** The meeting's Drive files, in the order they were first named. */
export const meetingDocumentsOf = (database: CacheDatabase, meetingId: number): MeetingDocument[] =>
  database
    .prepare(
      "SELECT l.target_text, l.role, l.metadata, CASE WHEN d.deleted_at IS NULL THEN l.to_id END AS to_id " +
        "FROM links l LEFT JOIN documents d ON d.id = l.to_id WHERE l.from_type = 'meeting' AND l.from_id = ? " +
        "AND l.kind = 'attached' AND l.to_type = 'document' ORDER BY l.id",
    )
    .all(meetingId)
    .flatMap((row) => {
      const role = roleOf(row.role)
      return role === undefined
        ? []
        : [
            {
              fileId: String(row.target_text).slice(driveFileTarget("").length),
              role,
              title: str(fromJson<{ title?: unknown } | null>(row.metadata)?.title),
              documentId: int(row.to_id),
            },
          ]
    })

export const meetingTranscriptDocumentsOver = ({ database }: StoreContext): MeetingTranscriptDocumentStore => {
  const meetingsOf = (documentIds: readonly number[], roles: readonly MeetingDocumentRole[]) =>
    read(database, () => {
      const rows = database
        .prepare(
          `SELECT l.to_id AS document_id, l.from_id AS meeting_id, m.account_id, l.role FROM links l
             JOIN meetings m ON m.id = l.from_id
           WHERE l.kind = 'attached' AND l.from_type = 'meeting' AND l.to_type = 'document'
             AND l.role IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL
             AND l.to_id IN (SELECT value FROM json_each(?))
           ORDER BY l.role = ? DESC, l.id`,
        )
        .all(JSON.stringify(roles), JSON.stringify(documentIds), TRANSCRIPT_ROLE)
      const found = new Map<number, DocumentMeeting>()
      for (const row of rows) {
        const role = roleOf(row.role)
        if (role !== undefined && !found.has(Number(row.document_id)))
          found.set(Number(row.document_id), {
            meetingId: Number(row.meeting_id),
            accountId: Number(row.account_id),
            role,
          })
      }
      return found
    })
  return {
    async transcriptMeetings(documentIds) {
      if (!documentIds.length) return new Map()
      const found = await meetingsOf(documentIds, [TRANSCRIPT_ROLE])
      return new Map([...found].map(([document, { meetingId }]) => [document, meetingId]))
    },
    async documentMeetings(documentIds) {
      return documentIds.length ? meetingsOf(documentIds, MEETING_DOCUMENT_ROLES) : new Map()
    },
  }
}
