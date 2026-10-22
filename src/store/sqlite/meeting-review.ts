import { CliError } from "@wirecat/cli-base"
import { type MeetingReviewItem, type MeetingReviewStore, REVIEW_LIMIT } from "../../meetings/index.js"
import { fromJson } from "./events.js"
import { checkMeetingCancelled } from "./meeting-operation.js"
import { positiveReadInteger } from "./meeting-reads.js"
import { meetingSelectionSql } from "./meeting-selection.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"

const number = (value: unknown) => (value === null || value === undefined ? null : Number(value))
const text = (value: unknown) => (value === null || value === undefined ? null : String(value))

/** Talk and words come from one transcript per meeting, its earliest current one, as in meeting stats. */
export const meetingReviewOver = ({ database }: StoreContext): MeetingReviewStore => ({
  async meetingReview(input) {
    checkMeetingCancelled(input.signal)
    positiveReadInteger(input.accountId, "accountId")
    const limit = input.limit ?? REVIEW_LIMIT.default
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > REVIEW_LIMIT.most)
      throw new CliError("validation_error", `a review shows 1 through ${REVIEW_LIMIT.most} meetings`)
    return read(database, () => {
      const { clauses, params } = meetingSelectionSql(input)
      const meetings = database
        .prepare(
          `SELECT m.id, m.account_id, m.title, m.started_at, m.duration_ms, m.participants_count FROM meetings m
           WHERE ${clauses.join(" AND ")} ORDER BY m.started_at DESC, m.id DESC LIMIT ?`,
        )
        .all(...params, limit + 1)
      const shown = meetings.slice(0, limit)
      const items = new Map<number, MeetingReviewItem>()
      for (const row of shown)
        items.set(Number(row.id), {
          meetingId: Number(row.id),
          accountId: Number(row.account_id),
          title: text(row.title),
          startedAt: number(row.started_at),
          durationMs: number(row.duration_ms),
          participantsCount: number(row.participants_count),
          projects: [],
          transcript: null,
          speakers: [],
          summary: null,
        })
      if (items.size) {
        const ids = [...items.keys()]
        const marks = ids.map(() => "?").join(",")
        checkMeetingCancelled(input.signal)
        const talk = database
          .prepare(
            `WITH chosen AS (SELECT min(t.id) AS id, t.meeting_id FROM meeting_transcripts t
               WHERE t.meeting_id IN (${marks}) AND t.deleted_at IS NULL AND t.superseded_at IS NULL GROUP BY t.meeting_id)
             SELECT c.meeting_id, coalesce(person.name, i.name, r.speaker_name, p.display_name) AS speaker,
               count(*) AS lines, sum(max(r.end_ms - r.start_ms, 0)) AS talk_ms,
               sum(length(trim(r.text)) - length(replace(trim(r.text), ' ', '')) + (length(trim(r.text)) > 0)) AS words
             FROM chosen c JOIN meeting_transcript_rows r ON r.meeting_transcript_id = c.id
             LEFT JOIN meeting_participants p ON p.id = r.speaker_participant_id
             LEFT JOIN identities i ON i.id = p.identity_id
             LEFT JOIN identity_links l ON l.identity_id = p.identity_id
             LEFT JOIN persons person ON person.id = l.person_id
             GROUP BY c.meeting_id, speaker ORDER BY c.meeting_id, talk_ms DESC`,
          )
          .all(...ids)
        for (const row of talk) {
          const item = items.get(Number(row.meeting_id)) as MeetingReviewItem
          item.transcript ??= { lines: 0, words: 0 }
          item.transcript.lines += Number(row.lines)
          item.transcript.words += Number(row.words)
          if (item.speakers.length < 3) item.speakers.push({ name: text(row.speaker), talkMs: Number(row.talk_ms) })
        }
        const transcribed = database
          .prepare(
            `SELECT DISTINCT meeting_id FROM meeting_transcripts
             WHERE meeting_id IN (${marks}) AND deleted_at IS NULL AND superseded_at IS NULL`,
          )
          .all(...ids)
        for (const row of transcribed) {
          const item = items.get(Number(row.meeting_id)) as MeetingReviewItem
          item.transcript ??= { lines: 0, words: 0 }
        }
        const summaries = database
          .prepare(
            `SELECT meeting_id, source, title, overview, next_steps, doc_url FROM meeting_summaries
             WHERE meeting_id IN (${marks}) ORDER BY coalesce(external_updated_at, updated_at) DESC, id DESC`,
          )
          .all(...ids)
        for (const row of summaries) {
          const item = items.get(Number(row.meeting_id)) as MeetingReviewItem
          item.summary ??= {
            source: String(row.source),
            title: text(row.title),
            overview: text(row.overview),
            nextSteps: fromJson<string[] | null>(row.next_steps) ?? [],
            url: text(row.doc_url),
          }
        }
        const projects = database
          .prepare(
            `SELECT l.from_id, p.name FROM links l JOIN projects p ON p.id = l.to_id
             WHERE l.from_type = 'meeting' AND l.from_id IN (${marks}) AND l.to_type = 'project' AND l.kind = 'member-of'
               AND l.anchor IS NULL AND l.confirmed = 1 AND p.account_id IS NULL AND p.deleted_at IS NULL ORDER BY p.name`,
          )
          .all(...ids)
        for (const row of projects)
          (items.get(Number(row.from_id)) as MeetingReviewItem).projects.push(String(row.name))
      }
      return { items: [...items.values()], hasMore: meetings.length > limit }
    })
  },
})
