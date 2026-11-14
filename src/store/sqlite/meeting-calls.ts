import { CliError } from "@wirecat/cli-base"
import type { MeetingCallsStore, StoredCall, StoredCallParticipant } from "../../meetings/index.js"
import { int, str } from "./events.js"
import { checkMeetingCancelled } from "./meeting-operation.js"
import { positiveReadInteger } from "./meeting-reads.js"
import { meetingSelectionSql } from "./meeting-selection.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"

const MOST_CALLS = 200_000

// The store keeps what the provider wrote; one unreadable value must not fail the whole report.
const parsed = (value: unknown): unknown => {
  if (typeof value !== "string") return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** The selected meetings with their metadata and people, through the same filters as meeting search and stats. */
export const meetingCallsOver = ({ database }: StoreContext): MeetingCallsStore => ({
  async meetingCalls(input) {
    checkMeetingCancelled(input.signal)
    positiveReadInteger(input.accountId, "accountId")
    const maxRows = input.maxRows ?? MOST_CALLS
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MOST_CALLS)
      throw new CliError("validation_error", `call stats read 1 through ${MOST_CALLS} calls`)
    return read(database, () => {
      const { clauses, params } = meetingSelectionSql(input)
      const meetings = database
        .prepare(
          `SELECT m.id, m.started_at, coalesce(m.duration_ms, m.ended_at - m.started_at) AS duration_ms, m.metadata
           FROM meetings m WHERE ${clauses.join(" AND ")} ORDER BY m.started_at, m.id LIMIT ?`,
        )
        .all(...params, maxRows + 1)
      if (meetings.length > maxRows)
        throw new CliError("validation_error", `the selection has more than ${maxRows} meetings; narrow it`)
      checkMeetingCancelled(input.signal)
      const people = new Map<number, StoredCallParticipant[]>()
      const rows = database
        .prepare(
          `SELECT p.meeting_id, p.identity_id, i.external_id AS identity_key, p.role,
             coalesce(p.display_name, i.name) AS name, p.external_id
           FROM meeting_participants p JOIN identities i ON i.id = p.identity_id
           WHERE p.meeting_id IN (SELECT m.id FROM meetings m WHERE ${clauses.join(" AND ")})
           ORDER BY p.id`,
        )
        .all(...params)
      for (const row of rows) {
        const meetingId = Number(row.meeting_id)
        people.set(meetingId, [
          ...(people.get(meetingId) ?? []),
          {
            identityId: Number(row.identity_id),
            identityKey: String(row.identity_key),
            role: str(row.role),
            name: str(row.name),
            externalId: str(row.external_id),
          },
        ])
      }
      return meetings.map(
        (row): StoredCall => ({
          meetingId: Number(row.id),
          startedAt: int(row.started_at),
          durationMs: int(row.duration_ms),
          metadata: parsed(row.metadata),
          participants: people.get(Number(row.id)) ?? [],
        }),
      )
    })
  },
})
