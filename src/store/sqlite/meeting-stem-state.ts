import { createStemmer, DEFAULT_STEMMERS, type Stemmer } from "../../search/stem.js"
import type { CacheDatabase } from "../driver.js"
import { NORMALIZER_VERSION } from "../normalize.js"
import { savedStemmers } from "./stems.js"

const summaryBytes = ["title", "overview", "sections", "next_steps", "content"]
  .map((key) => `coalesce(length(CAST(s.${key} AS BLOB)),0)`)
  .join("+")
export const meetingCurrentIndexRows = `
 SELECT 'meeting_transcript_row' AS indexable_type,r.id,r.id*4+1 AS rid,1 AS live,coalesce(length(CAST(r.text AS BLOB)),0) AS bytes FROM meeting_transcript_rows r JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id JOIN meetings m ON m.id=t.meeting_id WHERE m.account_id=? AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND t.superseded_at IS NULL
 UNION ALL SELECT 'meeting_chat_message',c.id,c.id*4+2,1,coalesce(length(CAST(c.text AS BLOB)),0) FROM meeting_chat_messages c JOIN meetings m ON m.id=c.meeting_id WHERE m.account_id=? AND m.deleted_at IS NULL
 UNION ALL SELECT 'meeting_summary',s.id,s.id*4+3,1,${summaryBytes} FROM meeting_summaries s JOIN meetings m ON m.id=s.meeting_id WHERE m.account_id=? AND m.deleted_at IS NULL`
export const meetingQueuedIndexRows = `SELECT p.indexable_type,p.id,
 CASE p.indexable_type WHEN 'meeting_transcript_row' THEN p.id*4+1 WHEN 'meeting_chat_message' THEN p.id*4+2 ELSE p.id*4+3 END AS rid,
 CASE WHEN m.deleted_at IS NOT NULL OR (p.indexable_type='meeting_transcript_row' AND (t.deleted_at IS NOT NULL OR t.superseded_at IS NOT NULL)) THEN 0 ELSE 1 END AS live,
 CASE WHEN m.deleted_at IS NOT NULL OR (p.indexable_type='meeting_transcript_row' AND (t.deleted_at IS NOT NULL OR t.superseded_at IS NOT NULL)) THEN 0
 WHEN p.indexable_type='meeting_transcript_row' THEN coalesce(length(CAST(r.text AS BLOB)),0)
 WHEN p.indexable_type='meeting_chat_message' THEN coalesce(length(CAST(c.text AS BLOB)),0) ELSE ${summaryBytes} END AS bytes
 FROM meeting_index_pending p LEFT JOIN meeting_transcript_rows r ON p.indexable_type='meeting_transcript_row' AND r.id=p.id LEFT JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id
 LEFT JOIN meeting_chat_messages c ON p.indexable_type='meeting_chat_message' AND c.id=p.id LEFT JOIN meeting_summaries s ON p.indexable_type='meeting_summary' AND s.id=p.id
 JOIN meetings m ON m.id=coalesce(t.meeting_id,c.meeting_id,s.meeting_id) WHERE m.account_id=?`
export const meetingStemStateName = (accountId: number): string => `meeting_stems:${accountId}`
export const meetingStemState = (
  database: CacheDatabase,
  accountId: number,
): { stemmer: Stemmer | null; identity: string; through: number; watermark: number } => {
  const choices = savedStemmers(database)
  const stemmer = choices === null ? null : createStemmer(choices ?? DEFAULT_STEMMERS)
  const identity = `${stemmer?.identity ?? "unknown"} normalizer=${NORMALIZER_VERSION}`
  const row = database
    .prepare("SELECT analyzer,normalizer_version,filled_through FROM search_index_state WHERE name=?")
    .get(meetingStemStateName(accountId))
  const through =
    row?.analyzer === identity && Number(row.normalizer_version) === NORMALIZER_VERSION ? Number(row.filled_through) : 0
  const watermark = Number(
    database
      .prepare(`SELECT coalesce(max(rid),0) AS n FROM (${meetingCurrentIndexRows})`)
      .get(accountId, accountId, accountId)?.n ?? 0,
  )
  return { stemmer, identity, through, watermark }
}
/** Word-only legacy maintenance invalidates stems without starting another rebuild. */
export const invalidateMeetingStems = (database: CacheDatabase, type: string, id: number): void => {
  const table =
    type === "meeting_transcript_row"
      ? "meeting_transcript_rows r JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id JOIN meetings m ON m.id=t.meeting_id"
      : type === "meeting_chat_message"
        ? "meeting_chat_messages r JOIN meetings m ON m.id=r.meeting_id"
        : "meeting_summaries r JOIN meetings m ON m.id=r.meeting_id"
  database
    .prepare(
      `UPDATE search_index_state SET filled_through=0,built_at=NULL WHERE name IN (SELECT 'meeting_stems:'||m.account_id FROM ${table} WHERE r.id=?)`,
    )
    .run(id)
}

/** Extremely long identifiers stay searchable literally without entering Snowball's suffix loops. */
export const meetingStemmableText = (text: string): string =>
  text.replace(/[\p{L}\p{N}\p{M}\p{Co}]+/gu, (token) => (token.length <= 1024 ? token : ""))
