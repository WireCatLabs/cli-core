import { CliError } from "@wirecat/cli-base"
import { aggregateMeetingStats, type MeetingStatsRow, type MeetingStatsStore } from "../../meetings/index.js"
import { checkMeetingCancelled } from "./meeting-operation.js"
import { positiveReadInteger } from "./meeting-reads.js"
import { meetingSelectionSql } from "./meeting-selection.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"

const MOST_ROWS = 500_000

/**
 * One transcript per meeting — its earliest current one — so a local transcript beside the provider's does not count
 * the talk twice. Words are counted from spaces in SQL, so no transcript text leaves the database.
 */
export const meetingStatsOver = ({ database }: StoreContext): MeetingStatsStore => ({
  async meetingStats(input) {
    checkMeetingCancelled(input.signal)
    positiveReadInteger(input.accountId, "accountId")
    const maxRows = input.maxRows ?? MOST_ROWS
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MOST_ROWS)
      throw new CliError("validation_error", `meeting stats read 1 through ${MOST_ROWS} transcript lines`)
    return read(database, () => {
      const { clauses, params } = meetingSelectionSql(input)
      const sql = `WITH selected AS (SELECT m.id, m.started_at FROM meetings m WHERE ${clauses.join(" AND ")}),
        chosen AS (SELECT min(t.id) AS id, t.meeting_id FROM meeting_transcripts t JOIN selected s ON s.id = t.meeting_id
          WHERE t.deleted_at IS NULL AND t.superseded_at IS NULL GROUP BY t.meeting_id)
        SELECT c.meeting_id, s.started_at, r.start_ms, r.end_ms,
          length(trim(r.text)) - length(replace(trim(r.text), ' ', '')) + (length(trim(r.text)) > 0) AS words,
          l.person_id, person.name AS person_name, p.identity_id, i.name AS identity_name,
          coalesce(r.speaker_name, p.display_name) AS speaker_name
        FROM chosen c JOIN selected s ON s.id = c.meeting_id
        JOIN meeting_transcript_rows r ON r.meeting_transcript_id = c.id
        LEFT JOIN meeting_participants p ON p.id = r.speaker_participant_id
        LEFT JOIN identities i ON i.id = p.identity_id
        LEFT JOIN identity_links l ON l.identity_id = p.identity_id
        LEFT JOIN persons person ON person.id = l.person_id
        LIMIT ?`
      const rows = database.prepare(sql).all(...params, maxRows + 1)
      if (rows.length > maxRows)
        throw new CliError("validation_error", `the selection has more than ${maxRows} transcript lines; narrow it`)
      checkMeetingCancelled(input.signal)
      const nullable = (value: unknown) => (value === null || value === undefined ? null : Number(value))
      const text = (value: unknown) => (value === null || value === undefined ? null : String(value))
      return aggregateMeetingStats(
        rows.map(
          (row): MeetingStatsRow => ({
            meetingId: Number(row.meeting_id),
            startedAt: nullable(row.started_at),
            startMs: Number(row.start_ms),
            endMs: Number(row.end_ms),
            words: Number(row.words),
            personId: nullable(row.person_id),
            personName: text(row.person_name),
            identityId: nullable(row.identity_id),
            identityName: text(row.identity_name),
            speakerName: text(row.speaker_name),
          }),
        ),
        input.timeZone,
      )
    })
  },
})
