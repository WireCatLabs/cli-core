import type { Summary } from "../../meetings/index.js"
import type { CacheDatabase } from "../driver.js"
import { fromJson, int, str } from "./events.js"

type Row = Record<string, unknown>

/**
 * Transcript rows, chat messages and summaries share `meeting_words` and their ids overlap, so each rowid is
 * the source id times 4 plus a type code: `rowid % 4` names the table, `rowid / 4` the id. Code 0 is unused.
 */
export const INDEX_CODES = { meeting_transcript_row: 1, meeting_chat_message: 2, meeting_summary: 3 } as const

export type Indexable = keyof typeof INDEX_CODES

export const meetingRowid = (type: Indexable, id: number): number => id * 4 + INDEX_CODES[type]

export const summaryOf = (row: Row): Summary => ({
  id: Number(row.id),
  meetingId: Number(row.meeting_id),
  source: String(row.source),
  title: str(row.title),
  overview: str(row.overview),
  sections: fromJson(row.sections) ?? [],
  nextSteps: fromJson(row.next_steps) ?? [],
  content: str(row.content),
  docUrl: str(row.doc_url),
  externalCreatedAt: int(row.external_created_at),
  externalUpdatedAt: int(row.external_updated_at),
  metadata: fromJson(row.metadata),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

export const summaryText = (s: Pick<Summary, "title" | "overview" | "sections" | "nextSteps" | "content">): string =>
  [s.title, s.overview, ...s.sections.map((section) => section.text), ...s.nextSteps, s.content]
    .filter(Boolean)
    .join("\n")

export const indexedText = (database: CacheDatabase, type: string, id: number): string | null => {
  if (type === "meeting_transcript_row")
    return str(database.prepare("SELECT text FROM meeting_transcript_rows WHERE id = ?").get(id)?.text)
  if (type === "meeting_chat_message")
    return str(database.prepare("SELECT text FROM meeting_chat_messages WHERE id = ?").get(id)?.text)
  const row = database
    .prepare("SELECT title,overview,sections,next_steps,content FROM meeting_summaries WHERE id = ?")
    .get(id)
  return row ? summaryText(summaryOf(row)) : null
}
