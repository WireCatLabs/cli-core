import { CliError } from "@wirecat/cli-base"
import {
  formatMeetingReference,
  type MeetingPreparationContext,
  type MeetingPreparationContextStore,
  validateMeetingPreparationContext,
} from "../../meetings/index.js"
import type { StoreContext } from "./open.js"
import { preparationQueries } from "./preparation-context-queries.js"
import { read } from "./transaction.js"

export const meetingPreparationContextOver = ({
  database,
}: Pick<StoreContext, "database">): MeetingPreparationContextStore => ({
  async preparationContext(original) {
    const input = validateMeetingPreparationContext(original)
    const { accountId, meetingId, seriesId, updatedAt, limit, maxReadBytes, signal } = input
    return read(database, () => {
      const live = database
        .prepare(
          "SELECT 1 FROM meetings m JOIN meeting_series s ON s.id=m.meeting_series_id WHERE m.id=? AND m.account_id=? AND s.account_id=? AND s.id=? AND m.updated_at=? AND m.deleted_at IS NULL AND s.deleted_at IS NULL",
        )
        .get(meetingId, accountId, accountId, seriesId, updatedAt)
      if (!live) throw new CliError("not_found", "The selected meeting history changed or is unavailable")
      const keys = ["participants", "projects", "facts", "tasks"] as const
      const params = (key: (typeof keys)[number]) =>
        key === "tasks"
          ? [formatMeetingReference({ type: "meeting", accountId, meetingId }), accountId, limit + 1]
          : [meetingId, limit + 1]
      let total = 0
      for (const key of keys) {
        const query = preparationQueries[key]
        const bytes = query.text.map((field) => `coalesce(length(CAST(${field} AS BLOB)),0)`).join("+")
        const probe = database
          .prepare(
            `SELECT coalesce(sum(read_bytes),0) AS read_bytes FROM (SELECT ${bytes} AS read_bytes ${query.from})`,
          )
          .get(...params(key))
        total += Number(probe?.read_bytes)
        if (!Number.isSafeInteger(total) || total < 0 || total > maxReadBytes)
          throw new CliError("validation_error", "Preparation context exceeds the stored text byte budget")
      }
      signal?.throwIfAborted()
      const read = <K extends (typeof keys)[number]>(key: K): MeetingPreparationContext[K] => {
        const query = preparationQueries[key]
        const rows = database.prepare(`SELECT ${query.fields} ${query.from}`).all(...params(key))
        return {
          items: rows.slice(0, limit).map((row) => query.map(row)),
          hasMore: rows.length > limit,
        } as MeetingPreparationContext[K]
      }
      const result = {
        participants: read("participants"),
        projects: read("projects"),
        facts: read("facts"),
        tasks: read("tasks"),
      }
      signal?.throwIfAborted()
      return result
    })
  },
})
