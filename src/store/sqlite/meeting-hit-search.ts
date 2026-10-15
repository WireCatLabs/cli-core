import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type { MeetingSearchOptions, MeetingSearchStore, SearchHit } from "../../meetings/index.js"
import { formatMeetingReference } from "../../meetings/index.js"
import type { SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import { indexedText } from "./meeting-index-values.js"
import { checkMeetingCancelled } from "./meeting-operation.js"
import { positiveReadInteger } from "./meeting-reads.js"
import { meetingStemmableText, meetingStemState } from "./meeting-stem-state.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"

interface Cursor {
  version: 1
  key: string
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
    parsed?.version !== 1 ||
    parsed.key !== key ||
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
      if (typeof rawQuery !== "string" || Buffer.byteLength(rawQuery) > 65536)
        fail("Meeting search query must be a bounded string")
      const rawWords = rawQuery.match(/[\p{L}\p{N}\p{M}]+/gu)?.filter((word) => normalize(word)) ?? []
      if (rawWords.length > 128) fail("Meeting search supports at most 128 query words")
      return read(database, () => {
        checkMeetingCancelled(input.signal)
        const state = meetingStemState(database, input.accountId)
        const terms = rawWords.map((raw) => ({
          literal: normalize(raw),
          stems:
            state.stemmer && raw.length <= 1024
              ? [...new Set(state.stemmer.explain(raw).map((word) => word.stem))]
              : [],
        }))
        const key = fingerprint(JSON.stringify(terms), input, state.identity)
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
        if (terms.length === 0) return { items: [], hasMore: false, nextCursor: null, coverage }
        const clauses = ["m.account_id=?", "m.deleted_at IS NULL"]
        const queryParams: SqlValue[] = []
        const termTables = terms.map((term, i) => {
          queryParams.push(`normalized_text : ("${term.literal}"*)`)
          let select = "SELECT rowid AS rid FROM meeting_words WHERE meeting_words MATCH ?"
          if (state.stemmer && state.through > 0 && term.stems.length) {
            queryParams.push(
              `stems : (${term.stems.map((stem) => `"${stem.replaceAll('"', '""')}"`).join(" OR ")})`,
              state.through,
            )
            select += " UNION SELECT rowid AS rid FROM meeting_stems WHERE meeting_stems MATCH ? AND rowid<=?"
          }
          return `term_${i} AS (${select})`
        })
        const matching = terms.map((_, i) => `SELECT rid FROM term_${i}`).join(" INTERSECT ")
        const params: SqlValue[] = [input.accountId]
        if (input.meetingId !== undefined) {
          clauses.push("m.id=?")
          params.push(input.meetingId)
        }
        if (input.eventId !== undefined) {
          clauses.push("m.event_id=?")
          params.push(input.eventId)
        }
        if (input.meetingSeriesId !== undefined) {
          clauses.push("m.meeting_series_id=?")
          params.push(input.meetingSeriesId)
        }
        if (input.since !== undefined) {
          clauses.push("m.started_at>=?")
          params.push(input.since)
        }
        if (input.until !== undefined) {
          clauses.push("m.started_at<=?")
          params.push(input.until)
        }
        if (input.participantIdentityId !== undefined) {
          clauses.push("EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id=m.id AND p.identity_id=?)")
          params.push(input.participantIdentityId)
        }
        if (input.personId !== undefined) {
          clauses.push(
            "EXISTS (SELECT 1 FROM meeting_participants p JOIN identity_links i ON i.identity_id=p.identity_id JOIN persons person ON person.id=i.person_id WHERE p.meeting_id=m.id AND person.id=?)",
          )
          params.push(input.personId)
        }
        if (input.projectId !== undefined) {
          clauses.push(
            "EXISTS (SELECT 1 FROM links l JOIN projects p ON p.id=l.to_id WHERE l.from_type='meeting' AND l.from_id=m.id AND l.to_type='project' AND l.kind='member-of' AND l.anchor IS NULL AND l.confirmed=1 AND p.id=? AND p.account_id IS NULL AND p.deleted_at IS NULL)",
          )
          params.push(input.projectId)
        }
        if (input.tagId !== undefined) {
          clauses.push(
            "EXISTS (SELECT 1 FROM taggings g JOIN tags t ON t.id=g.tag_id WHERE g.taggable_type='meeting' AND g.taggable_id=m.id AND t.id=?)",
          )
          params.push(input.tagId)
        }
        const seek = after
          ? "WHERE h.started<? OR (h.started=? AND (h.meeting_id>? OR (h.meeting_id=? AND (h.kind>? OR (h.kind=? AND h.id>?)))))"
          : ""
        if (after)
          params.push(after.started, after.started, after.meeting, after.meeting, after.kind, after.kind, after.id)
        const sql = `WITH ${termTables.join(",")}, matches AS (${matching}), matching AS (SELECT rid FROM matches h WHERE NOT EXISTS(SELECT 1 FROM meeting_index_pending p WHERE p.id=h.rid/4 AND p.indexable_type=CASE h.rid%4 WHEN 1 THEN 'meeting_transcript_row' WHEN 2 THEN 'meeting_chat_message' ELSE 'meeting_summary' END)), selected AS (SELECT m.id,coalesce(m.started_at,0) AS started FROM meetings m WHERE ${clauses.join(" AND ")}), hits AS (
        SELECT m.started,m.id AS meeting_id,0 AS kind,r.id,r.start_ms,${bytes("r", ["text"])} AS bytes,t.id AS transcript_id,r.position FROM matching h JOIN meeting_transcript_rows r ON h.rid%4=1 AND r.id=h.rid/4 JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id AND t.superseded_at IS NULL AND t.deleted_at IS NULL JOIN selected m ON m.id=t.meeting_id
        UNION ALL SELECT m.started,m.id,1,c.id,NULL,${bytes("c", ["text"])},NULL,NULL FROM matching h JOIN meeting_chat_messages c ON h.rid%4=2 AND c.id=h.rid/4 JOIN selected m ON m.id=c.meeting_id
        UNION ALL SELECT m.started,m.id,2,s.id,NULL,${bytes("s", fields)},NULL,NULL FROM matching h JOIN meeting_summaries s ON h.rid%4=3 AND s.id=h.rid/4 JOIN selected m ON m.id=s.meeting_id)
        SELECT h.*,${bytes("m", ["title"])}+${bytes("s", ["doc_url"])} AS context_bytes FROM hits h
        JOIN meetings m ON m.id=h.meeting_id LEFT JOIN meeting_summaries s ON h.kind=2 AND s.id=h.id
        ${seek} ORDER BY h.started DESC,h.meeting_id,h.kind,h.id LIMIT ?`
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
        const fresh = items.filter((item) => {
          const literalTokens = normalize(item.text).match(/[\p{L}\p{N}]+/gu) ?? []
          const missing = terms.filter((term) => !literalTokens.some((token) => token.startsWith(term.literal)))
          if (missing.length === 0) return true
          const stemTokens = state.stemmer
            ? new Set(state.stemmer.explain(meetingStemmableText(item.text)).map((word) => word.stem))
            : new Set<string>()
          return missing.every((term) => term.stems.some((stem) => stemTokens.has(stem)))
        })
        if (fresh.length !== items.length) coverage.indexing = "pending"
        const last = rows[limit - 1]
        const hasMore = rows.length > limit
        const nextCursor =
          hasMore && last
            ? Buffer.from(
                JSON.stringify({
                  version: 1,
                  key,
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
