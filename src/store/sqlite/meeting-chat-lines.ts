import { CliError } from "@wirecat/cli-base"
import { CHAT_MESSAGES_READ, type MeetingChatLinesStore } from "../../meetings/index.js"
import { checkMeetingCancelled } from "./meeting-operation.js"
import { positiveReadInteger } from "./meeting-reads.js"
import { meetingSelectionSql } from "./meeting-selection.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"

export const meetingChatLinesOver = ({ database }: StoreContext): MeetingChatLinesStore => ({
  async meetingChatLines(input) {
    checkMeetingCancelled(input.signal)
    positiveReadInteger(input.accountId, "accountId")
    const most = input.maxMessages ?? CHAT_MESSAGES_READ
    if (!Number.isSafeInteger(most) || most < 1 || most > CHAT_MESSAGES_READ)
      throw new CliError("validation_error", `read 1 through ${CHAT_MESSAGES_READ} chat messages`)
    return read(database, () => {
      const { clauses, params } = meetingSelectionSql(input)
      const rows = database
        .prepare(
          `SELECT c.meeting_id, m.account_id, m.title, c.sent_at, coalesce(c.sender_name, p.display_name) AS sender, c.text
           FROM meetings m JOIN meeting_chat_messages c ON c.meeting_id = m.id
           LEFT JOIN meeting_participants p ON p.id = c.sender_participant_id
           WHERE ${clauses.join(" AND ")} ORDER BY c.sent_at, c.id LIMIT ?`,
        )
        .all(...params, most + 1)
      if (rows.length > most)
        throw new CliError("validation_error", `the selection has more than ${most} chat messages; narrow it`)
      return rows.map((row) => ({
        meetingId: Number(row.meeting_id),
        accountId: Number(row.account_id),
        title: row.title === null ? null : String(row.title),
        sentAt: Number(row.sent_at),
        sender: row.sender === null ? null : String(row.sender),
        text: String(row.text),
      }))
    })
  },
})
