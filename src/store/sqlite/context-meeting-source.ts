import { CliError } from "@wirecat/cli-base"
import { type ContextEvidencePage, contextCursorScope, type contextEvidenceRequest } from "../../context/evidence.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import { read } from "./transaction.js"

type Request = ReturnType<typeof contextEvidenceRequest>

/** Transcript cues keep their retained revision reference; a meeting title alone is not a transcript match. */
export const readMeetingContextEvidence = (database: CacheDatabase, request: Request): ContextEvidencePage => {
  const { source, words, after, before, limit, maxReadBytes, cursor, signal } = request
  signal?.throwIfAborted()
  return read(database, () => {
    const coverage: ContextEvidencePage["coverage"] = {
      available: false,
      index: "unknown",
      hasMore: false,
      hasUndated: false,
      completeness: "unknown",
      matching: "literal-words",
      consistency: "snapshot-per-page",
    }
    const empty = (): ContextEvidencePage => ({ source, items: [], next: null, readBytes: 0, coverage })
    const scope: SqlValue[] = [source.accountId, source.provider, source.account]
    if (!database.prepare("SELECT 1 FROM accounts WHERE id=? AND provider=? AND external_id=?").get(...scope))
      return empty()
    coverage.available = true
    const base = `FROM meeting_transcript_rows r
      JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id
      JOIN meetings m ON m.id=t.meeting_id
      JOIN accounts a ON a.id=m.account_id
      WHERE m.account_id=? AND a.provider=? AND a.external_id=?
      AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND t.superseded_at IS NULL`
    coverage.hasUndated = Boolean(database.prepare(`SELECT 1 ${base} AND m.started_at IS NULL LIMIT 1`).get(...scope))
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meeting_words'").get()) {
      coverage.index = "missing"
      return empty()
    }
    coverage.index = database
      .prepare(`SELECT 1 ${base} AND m.started_at>=? AND m.started_at<?
        AND EXISTS(SELECT 1 FROM meeting_index_pending p
        WHERE p.indexable_type='meeting_transcript_row' AND p.id=r.id) LIMIT 1`)
      .get(...scope, after, before)
      ? "pending"
      : "ready"
    const reference = "'meeting:'||m.account_id||'/'||m.id||'/'||t.id||'/'||r.position"
    const selection = `SELECT r.id,m.title,r.text,a.provider,a.external_id AS account,
      m.started_at AS at,max(m.updated_at,t.updated_at,r.created_at) AS updated_at,
      ${reference} AS ref ${base} AND m.started_at>=? AND m.started_at<?
      AND (r.id*4+1) IN (SELECT rowid FROM meeting_words WHERE meeting_words MATCH ?)
      AND NOT EXISTS(SELECT 1 FROM meeting_index_pending p
        WHERE p.indexable_type='meeting_transcript_row' AND p.id=r.id)
      ${cursor ? "AND (m.started_at<? OR (m.started_at=? AND r.id<?))" : ""}
      ORDER BY m.started_at DESC,r.id DESC LIMIT ?`
    const params: SqlValue[] = [
      ...scope,
      after,
      before,
      words.map((word) => `normalized_text:"${normalize(word)}"`).join(" AND "),
    ]
    if (cursor) params.push(cursor.at, cursor.at, cursor.id)
    params.push(limit + 1)
    const probe = database
      .prepare(`SELECT coalesce(sum(length(CAST(coalesce(title,'') AS BLOB))+
        length(CAST(text AS BLOB))+length(CAST(provider AS BLOB))+
        length(CAST(account AS BLOB))+length(CAST(ref AS BLOB))+length('meeting-start')),0) AS bytes FROM (${selection})`)
      .get(...params)
    const readBytes = Number(probe?.bytes)
    if (!Number.isSafeInteger(readBytes) || readBytes < 0 || readBytes > maxReadBytes)
      throw new CliError("validation_error", "meeting context evidence exceeds maxReadBytes before hydration", {
        reason: "context.read-budget",
      })
    signal?.throwIfAborted()
    const rows = database.prepare(selection).all(...params)
    signal?.throwIfAborted()
    coverage.hasMore = rows.length > limit
    const selected = rows.slice(0, limit)
    const last = selected.at(-1)
    return {
      source,
      readBytes,
      coverage,
      next:
        coverage.hasMore && last
          ? { at: Number(last.at), id: Number(last.id), scope: contextCursorScope(request) }
          : null,
      items: selected.map((row) => ({
        ref: String(row.ref),
        provider: String(row.provider),
        account: String(row.account),
        title: row.title === null ? null : String(row.title),
        url: null,
        text: String(row.text),
        at: Number(row.at),
        timeKind: "meeting-start",
        updatedAt: Number(row.updated_at),
        revision: null,
      })),
    }
  })
}
