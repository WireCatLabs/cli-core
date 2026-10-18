import { CliError } from "@wirecat/cli-base"
import {
  type ContextEvidencePage,
  type ContextEvidenceReader,
  type ContextIndex,
  contextCursorScope,
  contextEvidenceRequest,
} from "../../context/evidence.js"
import { formatLocator } from "../../domain/locator.js"
import type { Stemmer, Stemmers } from "../../search/stem.js"
import type { SqlValue } from "../driver.js"
import { NORMALIZER_VERSION, normalize } from "../normalize.js"
import { contextDocumentTime, contextDocumentTimeKind, contextDocumentUrl } from "./context-document-source.js"
import { readMeetingContextEvidence } from "./context-meeting-source.js"
import { drainEmailIndex } from "./email-index.js"
import { drainNoteIndex } from "./note-index.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"

const corpora = {
  message: {
    table: "messages",
    index: "message_words",
    title: "c.title",
    body: "n.text",
    url: "NULL",
    at: "n.sent_at",
    revision: "NULL",
    chat: "c.external_id",
    timeKind: "'sent'",
    join: "JOIN chats c ON c.id=n.chat_id AND c.account_id=n.account_id",
    where: "c.searchable=1",
  },
  mail: {
    table: "emails",
    index: "email_words",
    title: "n.subject",
    body: "coalesce(n.body_text,'')",
    url: "NULL",
    at: "n.sent_at",
    revision: "NULL",
    chat: "c.external_id",
    timeKind: "'sent'",
    join: "JOIN email_threads c ON c.id=n.email_thread_id AND c.account_id=n.account_id",
    where: "a.provider='email'",
  },
  document: {
    table: "documents",
    index: "document_words",
    title: "n.title",
    body: "n.body",
    url: contextDocumentUrl,
    at: contextDocumentTime,
    revision: "n.revision",
    chat: "NULL",
    timeKind: contextDocumentTimeKind,
    join: "",
    where:
      "n.body IS NOT NULL AND CASE WHEN json_valid(n.metadata) THEN coalesce(json_extract(n.metadata, '$.catalog.active'),1) ELSE 1 END=1",
  },
} as const

/** No index fills, model loads or record hydration outside the read transaction. */
export const contextEvidenceOver = ({ database }: Pick<StoreContext, "database">): ContextEvidenceReader => ({
  async read(original) {
    const request = contextEvidenceRequest(original)
    const { source, words, after, before, limit, maxReadBytes, cursor, signal } = request
    if (source.kind === "meeting") return readMeetingContextEvidence(database, request)
    const corpus = corpora[source.kind]
    const scope = contextCursorScope({ source, query: request.query, after, before })
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
      const scopeParams: SqlValue[] = [source.accountId, source.provider, source.account]
      const account = database
        .prepare(
          `SELECT 1 FROM accounts WHERE id=? AND provider=? AND external_id=?${source.kind === "mail" ? " AND provider='email'" : ""}`,
        )
        .get(...scopeParams)
      if (!account) return empty()
      coverage.available = true
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(corpus.index)) {
        coverage.index = "missing"
        return empty()
      }
      const base = `FROM ${corpus.table} n JOIN accounts a ON a.id=n.account_id ${corpus.join}
        WHERE n.account_id=? AND a.provider=? AND a.external_id=? AND n.deleted_at IS NULL AND ${corpus.where}`
      coverage.hasUndated = Boolean(
        database.prepare(`SELECT 1 ${base} AND ${corpus.at} IS NULL LIMIT 1`).get(...scopeParams),
      )
      if (source.kind === "message") {
        const state = database
          .prepare("SELECT watermark,filled_through FROM search_index_state WHERE name='message_words'")
          .get()
        coverage.index = !state
          ? "unknown"
          : database
                .prepare(`SELECT 1 ${base} AND ${corpus.at}>=? AND ${corpus.at}<?
          AND (n.normalized_text IS NULL OR n.normalizer_version IS NULL OR n.normalizer_version<>${NORMALIZER_VERSION} OR (n.id>? AND n.id<=?)) LIMIT 1`)
                .get(...scopeParams, after, before, Number(state.filled_through), Number(state.watermark))
            ? "pending"
            : "ready"
      } else {
        coverage.index = database
          .prepare(`SELECT 1 ${base} AND ${corpus.at}>=? AND ${corpus.at}<?
          AND EXISTS(SELECT 1 FROM ${source.kind === "mail" ? "email" : "document"}_index_pending p
            WHERE p.id=n.id AND p.indexable_type=?) LIMIT 1`)
          .get(...scopeParams, after, before, source.kind === "mail" ? "email" : "document")
          ? "pending"
          : "ready"
      }
      const selection = `SELECT n.id,n.external_id,${corpus.chat} AS chat,a.provider,a.external_id AS account,
        ${corpus.title} AS title,${corpus.body} AS body,${corpus.url} AS url,${corpus.at} AS at,
        n.updated_at,${corpus.revision} AS revision,${corpus.timeKind} AS time_kind ${base}
        AND ${corpus.at}>=? AND ${corpus.at}<?
        AND n.id IN (SELECT rowid FROM ${corpus.index} WHERE ${corpus.index} MATCH ?)
        ${source.kind === "message" ? `AND n.normalized_text IS NOT NULL AND n.normalizer_version=${NORMALIZER_VERSION}` : `AND NOT EXISTS(SELECT 1 FROM ${source.kind === "mail" ? "email" : "document"}_index_pending p WHERE p.id=n.id AND p.indexable_type='${source.kind === "mail" ? "email" : "document"}')`}
        ${cursor ? `AND (${corpus.at}<? OR (${corpus.at}=? AND n.id<?))` : ""}
        ORDER BY ${corpus.at} DESC,n.id DESC LIMIT ?`
      const params: SqlValue[] = [
        ...scopeParams,
        after,
        before,
        words.map((w) => `normalized_text:"${normalize(w)}"`).join(" AND "),
      ]
      if (cursor) params.push(cursor.at, cursor.at, cursor.id)
      params.push(limit + 1)
      const probe = database
        .prepare(`SELECT coalesce(sum(
        length(CAST(coalesce(title,'') AS BLOB))+length(CAST(coalesce(body,'') AS BLOB))+
        length(CAST(coalesce(url,'') AS BLOB))+length(CAST(provider AS BLOB))+
        length(CAST(account AS BLOB))+length(CAST(external_id AS BLOB))+
        length(CAST(coalesce(chat,'') AS BLOB))+length(CAST(time_kind AS BLOB))),0) AS bytes FROM (${selection})`)
        .get(...params)
      const readBytes = Number(probe?.bytes)
      if (!Number.isSafeInteger(readBytes) || readBytes < 0 || readBytes > maxReadBytes)
        throw new CliError("validation_error", "context evidence exceeds maxReadBytes before hydration", {
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
        next: coverage.hasMore && last ? { at: Number(last.at), id: Number(last.id), scope } : null,
        items: selected.map((row) => ({
          ref:
            source.kind === "document"
              ? `document:${row.id}`
              : formatLocator({
                  provider: String(row.provider),
                  account: String(row.account),
                  chat: String(row.chat),
                  message: String(row.external_id),
                }),
          provider: String(row.provider),
          account: String(row.account),
          title: row.title == null ? null : String(row.title),
          url: row.url == null ? null : String(row.url),
          text: String(row.body),
          at: Number(row.at),
          timeKind: row.time_kind as "sent" | "source-modified" | "stored-update",
          updatedAt: Number(row.updated_at),
          revision: row.revision == null ? null : Number(row.revision),
        })),
      }
    })
  },
})

/** The same fills a mail search and the notes search run before reading; a message is indexed when it is saved. */
export const contextIndexOver = (
  { database }: Pick<StoreContext, "database">,
  stemmerFor: (stemmers: Stemmers) => Stemmer,
): ContextIndex => ({
  async catchUp({ kinds, signal }) {
    signal?.throwIfAborted()
    const mail = kinds.includes("mail") ? drainEmailIndex(database, stemmerFor) : 0
    signal?.throwIfAborted()
    const documents = kinds.includes("document") ? drainNoteIndex(database, stemmerFor) : 0
    return { mail, documents }
  },
})
