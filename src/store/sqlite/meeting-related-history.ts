import { CliError } from "@wirecat/cli-base"
import { type MeetingRelatedHistoryStore, validateMeetingRelatedHistory } from "../../meetings/index.js"
import { int, str } from "./events.js"
import { linkKind } from "./link-kinds.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"

export const meetingRelatedHistoryOver = ({
  database,
}: Pick<StoreContext, "database">): MeetingRelatedHistoryStore => ({
  async relatedHistory(original) {
    const input = validateMeetingRelatedHistory(original)
    const { accountId, seriesId, anchorIds, after, before, limit, maxReadBytes, signal } = input
    if (!anchorIds.length) return { items: [], hasMore: false }
    return read(database, () => {
      const anchors = `SELECT a.id FROM meetings a JOIN meeting_series s ON s.id=a.meeting_series_id
        WHERE a.id IN (${anchorIds.map(() => "?").join(",")}) AND a.account_id=? AND s.account_id=?
        AND s.id=? AND a.started_at>=? AND a.started_at<? AND a.deleted_at IS NULL AND s.deleted_at IS NULL`
      const person = `EXISTS(SELECT 1 FROM meeting_participants cp
        JOIN identity_links cl ON cl.identity_id=cp.identity_id
        JOIN identity_links al ON al.person_id=cl.person_id
        JOIN meeting_participants ap ON ap.identity_id=al.identity_id
        JOIN anchors a ON a.id=ap.meeting_id WHERE cp.meeting_id=m.id)`
      const project = `EXISTS(SELECT 1 FROM links c JOIN projects p ON p.id=c.to_id
        JOIN links a ON a.to_type='project' AND a.to_id=p.id AND a.from_type='meeting'
        AND a.kind=${linkKind("member-of")} AND a.confirmed=1
        JOIN anchors seed ON seed.id=a.from_id
        WHERE c.from_type='meeting' AND c.from_id=m.id AND c.to_type='project'
        AND c.kind=${linkKind("member-of")} AND c.confirmed=1 AND p.account_id IS NULL AND p.deleted_at IS NULL)`
      const selection = `WITH anchors AS (${anchors}), candidates AS (
        SELECT m.id,m.external_id,m.title,m.event_id,m.started_at,m.ended_at,m.updated_at,
        ${person} AS shared_person, ${project} AS shared_project
        FROM meetings m LEFT JOIN meeting_series s ON s.id=m.meeting_series_id
        WHERE m.account_id=? AND (m.meeting_series_id IS NULL OR m.meeting_series_id<>?)
        AND (m.meeting_series_id IS NULL OR (s.deleted_at IS NULL AND s.account_id=m.account_id))
        AND m.deleted_at IS NULL AND m.started_at>=? AND m.started_at<?)
        SELECT * FROM candidates WHERE shared_person OR shared_project ORDER BY started_at DESC,id DESC LIMIT ?`
      const params = [
        ...anchorIds,
        accountId,
        accountId,
        seriesId,
        after,
        before,
        accountId,
        seriesId,
        after,
        before,
        limit + 1,
      ]
      const probe = database
        .prepare(`SELECT coalesce(sum(read_bytes),0) AS read_bytes FROM (
        SELECT length(CAST(external_id AS BLOB))+coalesce(length(CAST(title AS BLOB)),0) AS read_bytes FROM (${selection}))`)
        .get(...params)
      const bytes = Number(probe?.read_bytes)
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxReadBytes)
        throw new CliError("validation_error", "Related history exceeds the stored text byte budget")
      signal?.throwIfAborted()
      const rows = database.prepare(selection).all(...params)
      signal?.throwIfAborted()
      return {
        items: rows.slice(0, limit).map((row) => ({
          meeting: {
            id: Number(row.id),
            externalId: String(row.external_id),
            title: str(row.title),
            eventId: int(row.event_id),
            startedAt: int(row.started_at),
            endedAt: int(row.ended_at),
            updatedAt: Number(row.updated_at),
          },
          sharedPerson: Boolean(row.shared_person),
          sharedProject: Boolean(row.shared_project),
        })),
        hasMore: rows.length > limit,
      }
    })
  },
})
