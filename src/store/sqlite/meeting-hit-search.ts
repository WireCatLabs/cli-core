import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type { MeetingSearchOptions, MeetingSearchStore, SearchHit } from "../../meetings/index.js"
import { formatMeetingReference, parseMeetingQuery } from "../../meetings/index.js"
import { matchMeetingText, meetingQuerySql, resolveMeetingQuery } from "./meeting-hit-query.js"
import { indexedText } from "./meeting-index-values.js"
import { checkMeetingCancelled } from "./meeting-operation.js"
import { positiveReadInteger } from "./meeting-reads.js"
import { meetingSelectionSql } from "./meeting-selection.js"
import { meetingStemState } from "./meeting-stem-state.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"

interface Cursor {
  version: 2
  key: string
  tier: number
  started: number
  meeting: number
  kind: number
  id: number
}
const fail = (message: string): never => {
  throw new CliError("validation_error", message)
}
const timestamp = (value: number | undefined): void => {
  if (value !== undefined && (!Number.isSafeInteger(value) || Math.abs(value) > 8640000000000000))
    fail("Invalid meeting search timestamp")
}
const fingerprint = (query: string, input: MeetingSearchOptions, analyzer: string): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        query,
        analyzer,
        input.accountId,
        input.meetingId ?? null,
        input.since ?? null,
        input.until ?? null,
        input.participantIdentityId ?? null,
        input.personId ?? null,
        input.projectId ?? null,
        input.tagId ?? null,
        input.eventId ?? null,
        input.meetingSeriesId ?? null,
      ]),
    )
    .digest("hex")
const cursorOf = (value: string | undefined, key: string): Cursor | null => {
  if (value === undefined) return null
  if (typeof value !== "string" || value.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(value))
    return fail("Invalid meeting search cursor")
  let parsed: Cursor
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor
  } catch {
    return fail("Invalid meeting search cursor")
  }
  if (
    parsed?.version !== 2 ||
    parsed.key !== key ||
    ![0, 1, 2].includes(parsed.tier) ||
    !Number.isSafeInteger(parsed.started) ||
    Math.abs(parsed.started) > 8640000000000000 ||
    !Number.isSafeInteger(parsed.meeting) ||
    parsed.meeting <= 0 ||
    !Number.isSafeInteger(parsed.id) ||
    parsed.id <= 0 ||
    !Number.isInteger(parsed.kind) ||
    parsed.kind < 0 ||
    parsed.kind > 2
  )
    return fail("Meeting search cursor does not match this query and account")
  return parsed
}
const fields = ["title", "overview", "sections", "next_steps", "content"]
const bytes = (alias: string, columns: string[]): string =>
  columns.map((column) => `coalesce(length(CAST(${alias}.${column} AS BLOB)),0)`).join("+")
export function meetingHitSearchOver({ database }: StoreContext): MeetingSearchStore {
  return {
    async searchHits(rawQuery, original) {
      const input = { ...original }
      checkMeetingCancelled(input.signal)
      positiveReadInteger(input.accountId, "accountId")
      if (input.meetingId !== undefined) positiveReadInteger(input.meetingId, "meetingId")
      for (const name of [
        "participantIdentityId",
        "personId",
        "projectId",
        "tagId",
        "eventId",
        "meetingSeriesId",
      ] as const)
        if (input[name] !== undefined) positiveReadInteger(input[name], name)
      timestamp(input.since)
      timestamp(input.until)
      if (input.since !== undefined && input.until !== undefined && input.until < input.since)
        fail("Meeting search dates must be ordered")
      const limit = input.limit ?? 100
      const maxReadBytes = input.maxReadBytes ?? 4 * 1024 ** 2
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        fail("Meeting search limit must be from 1 through 1000")
      if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > 64 * 1024 ** 2)
        fail("Meeting search byte limit must be from 1 through 67108864")
      if (typeof rawQuery === "string" && Buffer.byteLength(rawQuery) > 65536)
        fail("Meeting search query must be a bounded string")
      const ast = typeof rawQuery === "string" ? parseMeetingQuery(rawQuery) : rawQuery
      return read(database, () => {
        checkMeetingCancelled(input.signal)
        const state = meetingStemState(database, input.accountId)
        const tree = resolveMeetingQuery(database, input.accountId, ast, state)
        const key = fingerprint(JSON.stringify(tree), input, state.identity)
        const after = cursorOf(input.after, key)
        const pending = database
          .prepare(`SELECT 1 FROM meeting_index_pending p
          LEFT JOIN meeting_transcript_rows r ON p.indexable_type='meeting_transcript_row' AND r.id=p.id
          LEFT JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id
          LEFT JOIN meeting_chat_messages c ON p.indexable_type='meeting_chat_message' AND c.id=p.id
          LEFT JOIN meeting_summaries s ON p.indexable_type='meeting_summary' AND s.id=p.id
          JOIN meetings m ON m.id=coalesce(t.meeting_id,c.meeting_id,s.meeting_id)
          WHERE m.account_id=? AND m.deleted_at IS NULL AND
          (p.indexable_type!='meeting_transcript_row' OR (t.deleted_at IS NULL AND t.superseded_at IS NULL)) LIMIT 1`)
          .get(input.accountId)
        const coverage = {
          archiveCompleteness: "unknown" as const,
          currentRevisions: true as const,
          indexing:
            pending || !state.stemmer || state.through < state.watermark ? ("pending" as const) : ("ready" as const),
          indexCompleteness: "unknown" as const,
        }
        const { sql: matching, params: queryParams } = meetingQuerySql(tree, state)
        const { clauses, params } = meetingSelectionSql(input)
        const seek = after
          ? "WHERE h.tier>? OR (h.tier=? AND (h.started<? OR (h.started=? AND (h.meeting_id>? OR (h.meeting_id=? AND (h.kind>? OR (h.kind=? AND h.id>?)))))))"
          : ""
        if (after)
          params.push(
            after.tier,
            after.tier,
            after.started,
            after.started,
            after.meeting,
            after.meeting,
            after.kind,
            after.kind,
            after.id,
          )
        const sql = `WITH matches AS (${matching}), matching AS (SELECT rid,tier FROM matches h WHERE NOT EXISTS(SELECT 1 FROM meeting_index_pending p WHERE p.id=h.rid/4 AND p.indexable_type=CASE h.rid%4 WHEN 1 THEN 'meeting_transcript_row' WHEN 2 THEN 'meeting_chat_message' ELSE 'meeting_summary' END)), selected AS (SELECT m.id,coalesce(m.started_at,0) AS started FROM meetings m WHERE ${clauses.join(" AND ")}), hits AS (
        SELECT h.tier,m.started,m.id AS meeting_id,0 AS kind,r.id,r.start_ms,${bytes("r", ["text"])} AS bytes,t.id AS transcript_id,r.position FROM matching h JOIN meeting_transcript_rows r ON h.rid%4=1 AND r.id=h.rid/4 JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id AND t.superseded_at IS NULL AND t.deleted_at IS NULL JOIN selected m ON m.id=t.meeting_id
        UNION ALL SELECT h.tier,m.started,m.id,1,c.id,NULL,${bytes("c", ["text"])},NULL,NULL FROM matching h JOIN meeting_chat_messages c ON h.rid%4=2 AND c.id=h.rid/4 JOIN selected m ON m.id=c.meeting_id
        UNION ALL SELECT h.tier,m.started,m.id,2,s.id,NULL,${bytes("s", fields)},NULL,NULL FROM matching h JOIN meeting_summaries s ON h.rid%4=3 AND s.id=h.rid/4 JOIN selected m ON m.id=s.meeting_id)
        SELECT h.*,${bytes("m", ["title"])}+${bytes("s", ["doc_url"])} AS context_bytes FROM hits h
        JOIN meetings m ON m.id=h.meeting_id LEFT JOIN meeting_summaries s ON h.kind=2 AND s.id=h.id
        ${seek} ORDER BY h.tier,h.started DESC,h.meeting_id,h.kind,h.id LIMIT ?`
        const rows = database.prepare(sql).all(...queryParams, ...params, limit + 1)
        let total = 0
        const meetingMetadata = database.prepare(
          "SELECT title,started_at FROM meetings WHERE id=? AND account_id=? AND deleted_at IS NULL",
        )
        const sourceUrl = database.prepare("SELECT doc_url FROM meeting_summaries WHERE id=?")
        for (const row of rows) {
          const size = Number(row.bytes) + Number(row.context_bytes)
          if (!Number.isSafeInteger(size) || size < 0) fail("Invalid stored meeting search text size")
          total += size
          if (total > maxReadBytes) fail("Meeting search exceeds its stored text byte budget")
        }
        checkMeetingCancelled(input.signal)
        const items = rows.slice(0, limit).map((row): SearchHit & { ref: string } => {
          const kind = Number(row.kind)
          let text: string
          if (kind === 2) {
            try {
              text = indexedText(database, "meeting_summary", Number(row.id)) ?? ""
            } catch {
              throw new CliError("invalid_response", "Stored meeting summary has invalid structured text")
            }
          } else {
            const table = kind === 0 ? "meeting_transcript_rows" : "meeting_chat_messages"
            text = String(database.prepare(`SELECT text FROM ${table} WHERE id=?`).get(Number(row.id))?.text)
          }
          const metadata = meetingMetadata.get(Number(row.meeting_id), input.accountId)
          const url = kind === 2 ? sourceUrl.get(Number(row.id))?.doc_url : null
          return {
            source: {
              title: metadata?.title === null || metadata?.title === undefined ? null : String(metadata.title),
              startedAt:
                metadata?.started_at === null || metadata?.started_at === undefined
                  ? null
                  : Number(metadata.started_at),
              url: url === null || url === undefined ? null : String(url),
            },
            ref: formatMeetingReference({
              type: "meeting",
              accountId: input.accountId,
              meetingId: Number(row.meeting_id),
              ...(kind === 0 ? { transcriptId: Number(row.transcript_id), cuePosition: Number(row.position) } : {}),
            }),
            meetingId: Number(row.meeting_id),
            scope: kind === 0 ? "transcript" : kind === 1 ? "chat" : "summary",
            id: Number(row.id),
            text,
            startMs: row.start_ms === null ? null : Number(row.start_ms),
          }
        })
        const fresh = items.flatMap((item) => {
          const corrections = matchMeetingText(tree, item.text, state.stemmer)
          if (!corrections) return []
          return [
            corrections.length
              ? { ...item, match: "corrected" as const, corrections }
              : { ...item, match: "words" as const },
          ]
        })
        if (fresh.length !== items.length) coverage.indexing = "pending"
        const last = rows[limit - 1]
        const hasMore = rows.length > limit
        const nextCursor =
          hasMore && last
            ? Buffer.from(
                JSON.stringify({
                  version: 2,
                  key,
                  tier: Number(last.tier),
                  started: Number(last.started),
                  meeting: Number(last.meeting_id),
                  kind: Number(last.kind),
                  id: Number(last.id),
                }),
              ).toString("base64url")
            : null
        return { items: fresh, hasMore, nextCursor, coverage }
      })
    },
  }
}
