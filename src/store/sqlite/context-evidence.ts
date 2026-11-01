import {
  type ContextEvidencePage,
  type ContextEvidenceReader,
  type ContextIndex,
  type ContextRecordReader,
  contextCursorScope,
  contextEvidenceRequest,
  fittingRows,
} from "../../context/evidence.js"
import { formatLocator, parseLocator } from "../../domain/locator.js"
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
    chats: "chats",
    sender: "n.sender_identity_id",
    // A read that names the chat sees it even when it is hidden from search (searchable=0).
    named: "c.external_id=?",
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
    chats: "email_threads",
    sender: "n.from_identity_id",
    named: "a.provider='email' AND c.external_id=?",
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
    chats: null,
    sender: null,
    named: null,
  },
} as const

/** No index fills, model loads or record hydration outside the read transaction. */
export const contextEvidenceOver = ({ database }: Pick<StoreContext, "database">): ContextEvidenceReader => ({
  async read(original) {
    const request = contextEvidenceRequest(original)
    const { source, words, chat, senders, after, before, limit, maxReadBytes, cursor, signal } = request
    if (source.kind === "meeting") return readMeetingContextEvidence(database, request)
    const corpus = corpora[source.kind]
    const scope = contextCursorScope({ source, query: request.query, chat, senders, after, before })
    const searched = chat === undefined && senders === undefined
    signal?.throwIfAborted()
    return read(database, () => {
      const coverage: ContextEvidencePage["coverage"] = {
        available: false,
        index: "unknown",
        hasMore: false,
        hasUndated: false,
        completeness: "unknown",
        matching: chat !== undefined ? "chat" : senders !== undefined ? "sender" : "literal-words",
        consistency: "snapshot-per-page",
      }
      const empty = (): ContextEvidencePage => ({ source, items: [], next: null, readBytes: 0, coverage })
      const accountParams: SqlValue[] = [source.accountId, source.provider, source.account]
      const account = database
        .prepare(
          `SELECT 1 FROM accounts WHERE id=? AND provider=? AND external_id=?${source.kind === "mail" ? " AND provider='email'" : ""}`,
        )
        .get(...accountParams)
      if (!account) return empty()
      if (
        chat !== undefined &&
        !database
          .prepare(`SELECT 1 FROM ${corpus.chats} WHERE account_id=? AND external_id=?`)
          .get(source.accountId, chat)
      )
        return empty()
      coverage.available = true
      const scopeParams =
        chat !== undefined
          ? [...accountParams, chat]
          : senders !== undefined
            ? [...accountParams, ...senders]
            : accountParams
      const byChat = chat === undefined ? corpus.where : corpus.named
      const bySender =
        senders === undefined
          ? ""
          : ` AND ${corpus.sender} IN (SELECT id FROM identities WHERE provider=a.provider AND external_id IN (${senders.map(() => "?").join(",")}))`
      const from = `FROM ${corpus.table} n JOIN accounts a ON a.id=n.account_id ${corpus.join}`
      const where = `WHERE n.account_id=? AND a.provider=? AND a.external_id=? AND n.deleted_at IS NULL
        AND ${byChat}${bySender}`
      const base = `${from} ${where}`
      const author =
        corpus.sender === null
          ? { join: "", columns: "NULL AS sender_id" }
          : {
              join: `LEFT JOIN identities si ON si.id=${corpus.sender} LEFT JOIN identity_links sl ON sl.identity_id=si.id
                LEFT JOIN persons sp ON sp.id=sl.person_id`,
              columns: `si.provider AS sender_provider,si.external_id AS sender_id,si.name AS sender_name,
                sp.id AS sender_person,sp.name AS sender_person_name,
                coalesce(sp.owner=1,0) OR (si.provider=a.provider AND si.external_id=a.external_id) AS sender_owner`,
            }
      // A chat or sender read uses no word index, so words still waiting for it hide nothing.
      if (!searched) coverage.index = "ready"
      else if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(corpus.index)) {
        coverage.index = "missing"
        return empty()
      }
      coverage.hasUndated = Boolean(
        database.prepare(`SELECT 1 ${base} AND ${corpus.at} IS NULL LIMIT 1`).get(...scopeParams),
      )
      if (searched && source.kind === "message") {
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
      } else if (searched) {
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
        n.updated_at,${corpus.revision} AS revision,${corpus.timeKind} AS time_kind,${author.columns}
        ${from} ${author.join} ${where}
        AND ${corpus.at}>=? AND ${corpus.at}<?
        ${!searched ? "" : `AND n.id IN (SELECT rowid FROM ${corpus.index} WHERE ${corpus.index} MATCH ?)`}
        ${!searched ? "" : source.kind === "message" ? `AND n.normalized_text IS NOT NULL AND n.normalizer_version=${NORMALIZER_VERSION}` : `AND NOT EXISTS(SELECT 1 FROM ${source.kind === "mail" ? "email" : "document"}_index_pending p WHERE p.id=n.id AND p.indexable_type='${source.kind === "mail" ? "email" : "document"}')`}
        ${cursor ? `AND (${corpus.at}<? OR (${corpus.at}=? AND n.id<?))` : ""}
        ORDER BY ${corpus.at} DESC,n.id DESC LIMIT ?`
      const params: SqlValue[] = [...scopeParams, after, before]
      if (searched) params.push(words.map((w) => `normalized_text:"${normalize(w)}"`).join(" AND "))
      if (cursor) params.push(cursor.at, cursor.at, cursor.id)
      params.push(limit + 1)
      const sized = database
        .prepare(`SELECT id,at,provider,account,chat,external_id,
        length(CAST(coalesce(title,'') AS BLOB))+length(CAST(coalesce(body,'') AS BLOB))+
        length(CAST(coalesce(url,'') AS BLOB))+length(CAST(provider AS BLOB))+
        length(CAST(account AS BLOB))+length(CAST(external_id AS BLOB))+
        length(CAST(coalesce(chat,'') AS BLOB))+length(CAST(time_kind AS BLOB)) AS bytes FROM (${selection})`)
        .all(...params)
      const refOf = (row: Record<string, unknown>) =>
        source.kind === "document"
          ? `document:${row.id}`
          : formatLocator({
              provider: String(row.provider),
              account: String(row.account),
              chat: String(row.chat),
              message: String(row.external_id),
            })
      const past = (row: Record<string, unknown>) => ({ at: Number(row.at), id: Number(row.id), scope })
      const fit = fittingRows(
        sized.map((row) => Number(row.bytes)),
        limit,
        maxReadBytes,
      )
      const first = sized[0]
      if (!fit.count && first) {
        coverage.hasMore = sized.length > 1
        return {
          source,
          items: [],
          readBytes: 0,
          coverage,
          next: coverage.hasMore ? past(first) : null,
          oversized: { ref: refOf(first), bytes: Number(first.bytes) },
        }
      }
      signal?.throwIfAborted()
      params[params.length - 1] = fit.count
      const selected = fit.count ? database.prepare(selection).all(...params) : []
      signal?.throwIfAborted()
      coverage.hasMore = sized.length > selected.length
      const last = selected.at(-1)
      return {
        source,
        readBytes: fit.bytes,
        coverage,
        next: coverage.hasMore && last ? past(last) : null,
        items: selected.map((row) => ({
          ref: refOf(row),
          provider: String(row.provider),
          account: String(row.account),
          title: row.title == null ? null : String(row.title),
          url: row.url == null ? null : String(row.url),
          text: String(row.body),
          at: Number(row.at),
          timeKind: row.time_kind as "sent" | "source-modified" | "stored-update",
          updatedAt: Number(row.updated_at),
          revision: row.revision == null ? null : Number(row.revision),
          ...(corpus.sender === null
            ? {}
            : {
                sender:
                  row.sender_id == null
                    ? null
                    : {
                        provider: String(row.sender_provider),
                        id: String(row.sender_id),
                        name: row.sender_name == null ? null : String(row.sender_name),
                        person: row.sender_person == null ? null : `person:${row.sender_person}`,
                        personName: row.sender_person_name == null ? null : String(row.sender_person_name),
                        owner: Boolean(row.sender_owner),
                      },
              }),
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

/** The cited record by reference, read with the context reader's own columns, so fingerprints agree. */
export const contextRecordOf = (
  database: StoreContext["database"],
  ref: string,
): { ref: string; title: string | null; text: string; revision: number | null } | null => {
  if (typeof ref !== "string") return null
  const document = /^document:([1-9]\d*)$/.exec(ref)
  if (document) {
    const corpus = corpora.document
    const row = database
      .prepare(
        `SELECT ${corpus.title} AS title,${corpus.body} AS body,${corpus.revision} AS revision FROM documents n
         WHERE n.id=? AND n.deleted_at IS NULL AND ${corpus.where}`,
      )
      .get(Number(document[1]))
    return row
      ? {
          ref,
          title: row.title == null ? null : String(row.title),
          text: String(row.body),
          revision: row.revision == null ? null : Number(row.revision),
        }
      : null
  }
  const note = /^note:([1-9]\d*)$/.exec(ref)
  if (note) {
    const row = database
      .prepare("SELECT title, body, revision FROM notes WHERE id=? AND deleted_at IS NULL")
      .get(Number(note[1]))
    return row
      ? {
          ref,
          title: row.title == null ? null : String(row.title),
          text: String(row.body),
          revision: Number(row.revision),
        }
      : null
  }
  let at: ReturnType<typeof parseLocator>
  try {
    at = parseLocator(ref)
  } catch {
    return null
  }
  const corpus = at.provider === "email" ? corpora.mail : corpora.message
  const row = database
    .prepare(
      `SELECT ${corpus.title} AS title,${corpus.body} AS body FROM ${corpus.table} n JOIN accounts a ON a.id=n.account_id
       ${corpus.join} WHERE a.provider=? AND a.external_id=? AND n.external_id=?
       AND n.deleted_at IS NULL AND ${corpus.named}`,
    )
    .get(at.provider, at.account, at.message, at.chat)
  return row
    ? { ref, title: row.title == null ? null : String(row.title), text: String(row.body), revision: null }
    : null
}

export const contextRecordsOver = ({ database }: Pick<StoreContext, "database">): ContextRecordReader => ({
  async read(ref) {
    return read(database, () => contextRecordOf(database, ref))
  },
})
