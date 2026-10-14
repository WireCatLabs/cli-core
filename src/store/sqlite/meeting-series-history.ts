import { CliError } from "@wirecat/cli-base"
import { type MeetingSeriesHistoryStore, validateMeetingSeriesHistory } from "../../meetings/index.js"
import { int, str } from "./events.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"

const bytes = "length(CAST(external_id AS BLOB)) + coalesce(length(CAST(title AS BLOB)), 0)"
const ensureBytes = (size: number, budget: number) => {
  if (!Number.isSafeInteger(size) || size < 0 || size > budget)
    throw new CliError("validation_error", "Series history exceeds the stored text byte budget")
}

export const meetingSeriesHistoryOver = ({ database }: Pick<StoreContext, "database">): MeetingSeriesHistoryStore => ({
  async seriesHistory(input) {
    const request = validateMeetingSeriesHistory(input)
    const { accountId, externalId, after, before, limit, maxReadBytes, signal } = request
    return read(database, () => {
      const probe = database
        .prepare(
          `SELECT id, ${bytes} AS read_bytes FROM meeting_series WHERE account_id=? AND external_id=? AND deleted_at IS NULL`,
        )
        .get(accountId, externalId)
      if (!probe) {
        signal?.throwIfAborted()
        return { series: null, items: [], hasMore: false, hasUndated: false }
      }
      ensureBytes(Number(probe.read_bytes), maxReadBytes)
      const seriesId = Number(probe.id)
      const selection = `FROM meetings WHERE account_id=? AND meeting_series_id=? AND deleted_at IS NULL
        AND started_at>=? AND started_at<? ORDER BY started_at DESC, id DESC LIMIT ?`
      const params = [accountId, seriesId, after, before, limit + 1]
      const preflight = database
        .prepare(`SELECT coalesce(sum(read_bytes), 0) AS read_bytes FROM (SELECT ${bytes} AS read_bytes ${selection})`)
        .get(...params)
      ensureBytes(Number(probe.read_bytes) + Number(preflight?.read_bytes), maxReadBytes)
      signal?.throwIfAborted()
      const row = database
        .prepare("SELECT id, external_id, title, event_series_id, updated_at FROM meeting_series WHERE id=?")
        .get(seriesId)
      if (!row) throw new CliError("not_found", "Meeting series not found")
      const found = database
        .prepare(`SELECT id, external_id, title, event_id, started_at, ended_at, updated_at ${selection}`)
        .all(...params)
      const hasUndated = Boolean(
        database
          .prepare(
            "SELECT 1 FROM meetings WHERE account_id=? AND meeting_series_id=? AND deleted_at IS NULL AND started_at IS NULL LIMIT 1",
          )
          .get(accountId, seriesId),
      )
      signal?.throwIfAborted()
      return {
        series: {
          id: seriesId,
          externalId: String(row.external_id),
          title: str(row.title),
          eventSeriesId: int(row.event_series_id),
          updatedAt: Number(row.updated_at),
        },
        items: found.slice(0, limit).map((entry) => ({
          id: Number(entry.id),
          externalId: String(entry.external_id),
          title: str(entry.title),
          eventId: int(entry.event_id),
          startedAt: int(entry.started_at),
          endedAt: int(entry.ended_at),
          updatedAt: Number(entry.updated_at),
        })),
        hasMore: found.length > limit,
        hasUndated,
      }
    })
  },
})
