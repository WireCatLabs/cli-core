import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import {
  type MeetingParticipantPage,
  type MeetingParticipantSearchStore,
  normalizeMeetingParticipantQuery,
  validateMeetingParticipantSearch,
} from "../../meetings/index.js"
import { meetingReadSnapshot } from "./meeting-reads.js"
import type { StoreContext } from "./open.js"

interface Cursor {
  version: 1
  key: string
  after: number
  until: number
}

const cursorOf = (value: string | undefined, key: string): Cursor | null => {
  if (value === undefined) return null
  const fail = (): never => {
    throw new CliError("validation_error", "participant cursor does not match this account and query")
  }
  if (typeof value !== "string" || value.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(value)) return fail()
  let parsed: Cursor
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor
  } catch {
    return fail()
  }
  if (
    parsed?.version !== 1 ||
    parsed.key !== key ||
    !Number.isSafeInteger(parsed.after) ||
    parsed.after < 1 ||
    !Number.isSafeInteger(parsed.until) ||
    parsed.until < parsed.after
  )
    return fail()
  return parsed
}

export const meetingParticipantSearchOver = (context: StoreContext): MeetingParticipantSearchStore => ({
  async participantCandidates(query, input) {
    const limits = validateMeetingParticipantSearch(query, input)
    const key = createHash("sha256")
      .update(JSON.stringify([limits.accountId, limits.query]))
      .digest("hex")
    const previous = cursorOf(input.cursor, key)
    return meetingReadSnapshot(context.database, () => {
      const { database } = context
      const until =
        previous?.until ??
        Number(
          database
            .prepare(
              `SELECT coalesce(max(p.id), 0) AS id FROM meeting_participants p
               JOIN meetings m ON m.id = p.meeting_id WHERE m.account_id = ? AND m.deleted_at IS NULL`,
            )
            .get(limits.accountId)?.id,
        )
      const rows = database
        .prepare(
          `SELECT p.id,
             coalesce(length(CAST(p.display_name AS BLOB)), 0) + coalesce(length(CAST(p.email AS BLOB)), 0) AS bytes
           FROM meeting_participants p JOIN meetings m ON m.id = p.meeting_id
           WHERE m.account_id = ? AND m.deleted_at IS NULL AND p.id > ? AND p.id <= ?
           ORDER BY p.id LIMIT ?`,
        )
        .all(limits.accountId, previous?.after ?? 0, until, limits.scanLimit + 1)
      const read = database.prepare(
        "SELECT id, meeting_id, identity_id, display_name, email FROM meeting_participants WHERE id = ?",
      )
      const result: MeetingParticipantPage = {
        schema_version: 1,
        kind: "meeting_participants",
        account_id: limits.accountId,
        query: query.trim(),
        items: [],
        limit: limits.limit,
        has_more: false,
        next_cursor: null,
        ambiguity: { scope: "page", multiple_identities: false, identity_ids: [] },
        coverage: { scanned: 0, read_bytes: 0, archive_completeness: "unknown", truncated_by: null },
      }
      let after = previous?.after ?? 0
      for (const row of rows) {
        input.signal?.throwIfAborted()
        if (result.items.length === limits.limit) result.coverage.truncated_by = "limit"
        else if (result.coverage.scanned === limits.scanLimit) result.coverage.truncated_by = "scan_limit"
        else if (result.coverage.read_bytes + Number(row.bytes) > limits.maxReadBytes) {
          if (result.coverage.scanned === 0)
            throw new CliError("validation_error", "participant observation exceeds maxReadBytes before text read")
          result.coverage.truncated_by = "read_bytes"
        }
        if (result.coverage.truncated_by) break
        const found = read.get(Number(row.id))
        if (!found) throw new CliError("invalid_response", "participant observation disappeared within its snapshot")
        const name = found.display_name === null ? null : String(found.display_name)
        const email = found.email === null ? null : String(found.email)
        after = Number(row.id)
        result.coverage.scanned++
        result.coverage.read_bytes += Number(row.bytes)
        if (!normalizeMeetingParticipantQuery(`${name ?? ""} ${email ?? ""}`).includes(limits.query)) continue
        result.items.push({
          participant_id: after,
          meeting_id: Number(found.meeting_id),
          identity_id: Number(found.identity_id),
          display_name: name,
          email,
        })
      }
      result.has_more = result.coverage.truncated_by !== null
      if (result.has_more)
        result.next_cursor = Buffer.from(JSON.stringify({ version: 1, key, after, until })).toString("base64url")
      result.ambiguity.identity_ids = [...new Set(result.items.map((item) => item.identity_id))]
      result.ambiguity.multiple_identities = result.ambiguity.identity_ids.length > 1
      input.signal?.throwIfAborted()
      return result
    })
  },
})
