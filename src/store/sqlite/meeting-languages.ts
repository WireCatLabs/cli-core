import { type MeetingStore, transcriptLanguage } from "../../meetings/index.js"
import { positiveReadInteger } from "./meeting-reads.js"
import type { StoreContext } from "./open.js"
import { read, writeBatch } from "./transaction.js"

export type MeetingLanguageStore = Required<Pick<MeetingStore, "fillTranscriptLanguages">>

export const meetingLanguagesOver = ({ database }: StoreContext): MeetingLanguageStore => ({
  async fillTranscriptLanguages({ accountId, apply, now }) {
    positiveReadInteger(accountId, "accountId")
    const found = read(database, () => {
      const rows = database.prepare("SELECT text FROM meeting_transcript_rows WHERE meeting_transcript_id = ?")
      return database
        .prepare(
          `SELECT t.id FROM meeting_transcripts t JOIN meetings m ON m.id = t.meeting_id
           WHERE m.account_id = ? AND t.language IS NULL AND t.deleted_at IS NULL ORDER BY t.id`,
        )
        .all(accountId)
        .map(({ id }) => ({
          id: Number(id),
          language: transcriptLanguage(rows.all(Number(id)).map((row) => String(row.text))),
        }))
    })
    if (apply) {
      const update = database.prepare(
        "UPDATE meeting_transcripts SET language = ?, updated_at = ? WHERE id = ? AND language IS NULL",
      )
      writeBatch(database, () => {
        for (const { id, language } of found) if (language !== null) update.run(language, now, id)
      })
    }
    const counts = new Map<string | null, number>()
    for (const { language } of found) counts.set(language, (counts.get(language) ?? 0) + 1)
    return {
      accountId,
      applied: apply,
      transcripts: found.length,
      languages: [...counts].map(([language, transcripts]) => ({ language, transcripts })),
    }
  },
})
