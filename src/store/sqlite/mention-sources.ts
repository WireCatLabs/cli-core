import { CliError } from "@wirecat/cli-base"
import type { QueryAst } from "@wirecat/cli-base/query"
import type { Decider, MentionKind } from "../../domain/mentions.js"
import type { SqlValue } from "../driver.js"
import { findAccountPk } from "./accounts.js"
import {
  candidatesOf,
  columnsOf,
  confirmMention,
  type LocatedMention,
  type MentionDecision,
  type MentionStatus,
  mentionOwner,
  rejectMention,
} from "./mentions.js"
import type { StoreContext } from "./open.js"
import { queryFilter } from "./query-filter.js"
import { write } from "./transaction.js"

/** Texts outside a chat whose mentions memo lists: messages and their files are the messenger's `mentions`. */
export const OTHER_SOURCES = ["document", "note", "email"] as const
export type OtherSource = (typeof OTHER_SOURCES)[number]

/** A mention in a document, a note or an email, with what names the text it was found in. */
export interface SourceMention {
  id: number
  kind: MentionKind
  value: string
  domain: string | null
  status: MentionStatus
  author: string | null
  target: string | null
  foundAt: string
  written: string
  /** The text: its store id, its title (an email's subject), an email's sender address, when it was written. */
  source: { type: OtherSource; id: number; title: string | null; from: string | null; at: string | null }
}

export interface SourceMentionStore {
  /** The mentions of one kind of text that match the query, newest text first; mail only of `mail` accounts. */
  list(
    source: OtherSource,
    query: QueryAst | undefined,
    window: { limit?: number; offset: number },
    mail: readonly { provider: string; account: string }[],
  ): Promise<{ items: SourceMention[]; hasMore: boolean }>
  show(
    id: number,
    mail: readonly { provider: string; account: string }[],
  ): Promise<(SourceMention & { before: string; after: string; sameValue: number; candidates: string[] }) | undefined>
  confirm(
    id: number,
    owner: string | undefined,
    by: Decider,
    mail: readonly { provider: string; account: string }[],
  ): Promise<MentionDecision>
  reject(id: number, by: Decider, mail: readonly { provider: string; account: string }[]): Promise<MentionDecision>
}

const TEXTS: Record<OtherSource, string> = {
  document: "JOIN documents s ON mn.source_type = 'document' AND s.id = mn.source_id AND s.deleted_at IS NULL WHERE 1 ",
  note: "JOIN notes s ON mn.source_type = 'note' AND s.id = mn.source_id AND s.deleted_at IS NULL WHERE 1 ",
  email: "JOIN emails s ON mn.source_type = 'email' AND s.id = mn.source_id AND s.deleted_at IS NULL WHERE 1 ",
}
const COLUMNS: Record<OtherSource, string> = {
  document: "s.body AS text, s.title, NULL AS sender, coalesce(s.external_updated_at, s.updated_at) AS at",
  note: "s.body AS text, s.title, NULL AS sender, s.updated_at AS at",
  email: "s.body_text AS text, s.subject AS title, s.from_address AS sender, coalesce(s.sent_at, s.received_at) AS at",
}
const select = (source: OtherSource) =>
  "SELECT mn.id, mn.kind, mn.value, mn.domain, mn.status, mn.author, mn.target_type, mn.target_id, mn.created_at, " +
  `mn.source_id, mn.start_offset, mn.end_offset, ${COLUMNS[source]} FROM mentions mn ${TEXTS[source]}`

const sourceMention = (source: OtherSource, row: Record<string, unknown>): SourceMention => ({
  id: Number(row.id),
  kind: String(row.kind) as MentionKind,
  value: String(row.value),
  domain: row.domain == null ? null : String(row.domain),
  status: String(row.status) as MentionStatus,
  author: row.author == null ? null : String(row.author),
  target: row.target_id == null ? null : `${String(row.target_type)}:${Number(row.target_id)}`,
  foundAt: new Date(Number(row.created_at)).toISOString(),
  written: String(row.text).slice(Number(row.start_offset), Number(row.end_offset)),
  source: {
    type: source,
    id: Number(row.source_id),
    title: row.title == null ? null : String(row.title),
    from: row.sender == null ? null : String(row.sender),
    at: row.at == null ? null : new Date(Number(row.at)).toISOString(),
  },
})

export const sourceMentionStoreOver = (context: StoreContext): SourceMentionStore => {
  const { database } = context
  // Mail is read only from the accounts the caller names; documents and notes belong to no messenger account.
  const allowed = (source: OtherSource, mail: readonly { provider: string; account: string }[]) => {
    if (source !== "email") return { sql: "", params: [] as SqlValue[] }
    const pks = mail.flatMap((key) => findAccountPk(context, key) ?? [])
    return { sql: `AND s.account_id IN (${pks.map(() => "?").join(", ") || "NULL"}) `, params: pks }
  }
  const find = (id: number, mail: readonly { provider: string; account: string }[]) => {
    const type = database.prepare("SELECT source_type FROM mentions WHERE id = ?").get(id)?.source_type
    const source = OTHER_SOURCES.find((one) => one === type)
    if (!source) return undefined
    const scope = allowed(source, mail)
    const row = database.prepare(`${select(source)}AND mn.id = ? ${scope.sql}`).get(id, ...scope.params)
    return row ? { source, row } : undefined
  }
  const located = (id: number, mail: readonly { provider: string; account: string }[]): LocatedMention => {
    const found = find(id, mail)
    if (!found) throw new CliError("not_found", `no mention ${id} in a document, a note or this mail`)
    return { id, kind: String(found.row.kind) as MentionKind, value: String(found.row.value), chat: null }
  }
  return {
    list: async (source, query, { limit, offset }, mail) => {
      const scope = allowed(source, mail)
      const where = [scope.sql]
      let params = scope.params
      if (query) {
        const compiled = queryFilter(query, columnsOf(database))
        if (compiled.sql) {
          where.push(`AND (${compiled.sql}) `)
          params = params.concat(compiled.params)
        }
      }
      const rows = database
        .prepare(
          `${select(source)}${where.join("")}ORDER BY at DESC, mn.source_id DESC, mn.start_offset, mn.id LIMIT ? OFFSET ?`,
        )
        .all(...params, limit === undefined ? -1 : limit + 1, offset)
      const items = rows.map((row) => sourceMention(source, row))
      if (limit === undefined || items.length <= limit) return { items, hasMore: false }
      return { items: items.slice(0, limit), hasMore: true }
    },
    show: async (id, mail) => {
      const found = find(id, mail)
      if (!found) return undefined
      const mention = sourceMention(found.source, found.row)
      const text = String(found.row.text)
      const [start, end] = [Number(found.row.start_offset), Number(found.row.end_offset)]
      const sameValue = Number(
        database
          .prepare("SELECT count(*) AS n FROM mentions WHERE kind = ? AND value = ? AND id <> ?")
          .get(mention.kind, mention.value, id)?.n,
      )
      return {
        ...mention,
        before: text.slice(Math.max(0, start - 80), start),
        after: text.slice(end, end + 80),
        sameValue,
        candidates: candidatesOf(database, mention, null),
      }
    },
    confirm: async (id, owner, by, mail) => {
      const mention = located(id, mail)
      return write(database, () => confirmMention(context, mention, mentionOwner(context, owner), by))
    },
    reject: async (id, by, mail) => {
      const mention = located(id, mail)
      return write(database, () => rejectMention(context, mention, by))
    },
  }
}
