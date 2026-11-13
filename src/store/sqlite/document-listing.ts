import { CliError } from "@wirecat/cli-base"
import type { QueryAst } from "@wirecat/cli-base/query"
import { normalizeTag } from "../../domain/tags.js"
import type { SqlValue } from "../driver.js"
import { fold } from "../normalize.js"
import { accountOf, type ListedAccount } from "./meeting-listing.js"
import { idsOf } from "./merged-persons.js"
import type { StoreContext } from "./open.js"
import { type ColumnMap, queryFilter, type Where } from "./query-filter.js"
import { canonicalTagNamed } from "./tags.js"
import { thingOf } from "./things.js"
import { read } from "./transaction.js"

/** What a document is to a person, from its MIME type and file name: the Documents page filters and shows by it. */
export const DOCUMENT_KINDS = [
  "transcript",
  "doc",
  "sheet",
  "slides",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "csv",
  "md",
  "txt",
  "html",
  "page",
  "image",
  "other",
] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

const ext = "lower(coalesce(d.extension, ''))"
const mime = "coalesce(f.mime, d.mime, '')"
const among = (values: readonly string[]) => `${ext} IN (${values.map((value) => `'${value}'`).join(", ")})`

/** A meeting's transcript saved as a document (a Meet transcript Drive imported) is a transcript whatever its type. */
const TRANSCRIPT_LINK =
  "EXISTS (SELECT 1 FROM links tl WHERE tl.to_type = 'document' AND tl.to_id = d.id AND tl.from_type = 'meeting' " +
  "AND tl.kind = 'attached' AND tl.role = 'transcript')"

export const DOCUMENT_KIND_SQL = `CASE
  WHEN ${among(["vtt", "srt"])} OR ${TRANSCRIPT_LINK} THEN 'transcript'
  WHEN ${mime} = 'application/vnd.google-apps.document' THEN 'doc'
  WHEN ${mime} = 'application/vnd.google-apps.spreadsheet' THEN 'sheet'
  WHEN ${mime} = 'application/vnd.google-apps.presentation' THEN 'slides'
  WHEN ${mime} = 'application/pdf' OR ${among(["pdf"])} THEN 'pdf'
  WHEN ${among(["docx", "doc", "odt", "rtf", "epub"])} OR ${mime} LIKE 'application/vnd.openxmlformats-officedocument.wordprocessingml%' THEN 'docx'
  WHEN ${among(["xlsx", "xls", "ods"])} OR ${mime} LIKE 'application/vnd.openxmlformats-officedocument.spreadsheetml%' THEN 'xlsx'
  WHEN ${among(["pptx", "ppt", "odp"])} OR ${mime} LIKE 'application/vnd.openxmlformats-officedocument.presentationml%' THEN 'pptx'
  WHEN ${among(["csv", "tsv"])} OR ${mime} IN ('text/csv', 'text/tab-separated-values') THEN 'csv'
  WHEN ${among(["md", "markdown"])} OR ${mime} = 'text/markdown' THEN 'md'
  WHEN ${among(["txt", "text", "log"])} OR ${mime} = 'text/plain' THEN 'txt'
  WHEN ${among(["html", "htm"])} OR ${mime} = 'text/html' THEN 'html'
  WHEN ${mime} LIKE 'image/%' THEN 'image'
  WHEN d.kind = 'page' THEN 'page'
  WHEN d.kind = 'text' THEN 'txt'
  ELSE 'other' END`

/** The file a document shows: live first, the owner's pin, then the newest (`PREFERRED_FILE`), joined as `f`. */
const PREFERRED =
  "LEFT JOIN files f ON f.id = (SELECT f2.id FROM files f2 WHERE f2.document_id = d.id AND f2.kind <> 'folder' " +
  "ORDER BY f2.deleted_at IS NOT NULL, f2.id IS NOT d.pinned_file_id, coalesce(f2.external_updated_at, f2.updated_at) DESC, " +
  "f2.id DESC LIMIT 1)"

/** Documents a list shows: not deleted, not a folder, and still in its source's catalog. */
const LISTED =
  "d.deleted_at IS NULL AND d.kind <> 'folder' AND coalesce(json_extract(d.metadata, '$.catalog.active'), 1) = 1"

const MODIFIED = "coalesce(f.external_updated_at, d.external_updated_at, d.updated_at)"

/** A document's place: its preferred file's path, else where a folder import put it. */
const PATH = "coalesce(f.path, CASE WHEN d.storage = 'local' THEN d.external_id END)"

export interface DocumentListFilter {
  /** Stored account ids; every account when left out. */
  accountIds?: readonly number[]
  /** The rest of the list's query, over `DOCUMENT_LIST_COLUMNS`' fields. */
  query?: QueryAst
  /** Only these documents, in this order: what a text search found, best first. */
  ids?: readonly number[]
  zone?: string
  now?: number
  limit: number
  offset: number
}

export interface DocumentListRow {
  id: number
  accountId: number
  provider: string
  account: string
  accountName: string | null
  title: string | null
  fileName: string | null
  kind: DocumentKind
  mime: string | null
  size: number | null
  url: string | null
  /** A copy the store keeps of an added file, or a local file's own path when the writer kept one. */
  localPath: string | null
  /** Where the source keeps it, relative to the account: a Drive folder path, a notes folder's path. */
  path: string | null
  folder: string | null
  modifiedAt: number | null
  storedAt: number
  hasText: boolean
}

export interface DocumentFolderNode {
  name: string
  path: string
  /** Documents in it and in every folder under it. */
  count: number
  folders: DocumentFolderNode[]
}

export interface DocumentSourceNode {
  accountId: number
  provider: string
  account: string
  name: string | null
  count: number
  /** Documents kept at the top, in no folder. */
  loose: number
  folders: DocumentFolderNode[]
}

export interface DocumentLink {
  ref: string
  title: string | null
  at: number | null
  role: string | null
}

export interface DocumentDetail extends DocumentListRow {
  text: string | null
  /** The text's length in characters, all of it, whatever part `text` holds. */
  textLength: number
  extraction: string | null
  extractionError: string | null
  language: string | null
  tags: string[]
  people: { ref: string; name: string | null; kind: string }[]
  meetings: DocumentLink[]
  events: DocumentLink[]
}

export interface DocumentListing {
  /** Every account holding a listed document: what a list reads when no source narrows it. */
  documentAccounts(): Promise<ListedAccount[]>
  /** One page of every document the filter takes, newest change first (or in `ids`' order). */
  documents(filter: DocumentListFilter): Promise<{ items: DocumentListRow[]; total: number }>
  /** Provider → account → folder, with how many documents each holds, for the accounts given or all of them. */
  documentSources(filter: { accountIds?: readonly number[]; depth: number }): Promise<DocumentSourceNode[]>
  /** One listed document with a part of its text, from `offset` for `limit` characters. */
  document(id: number, text: { offset: number; limit: number }): Promise<DocumentDetail | undefined>
}

const COLUMNS = `d.id, d.account_id, a.provider, a.external_id AS account, a.name AS account_name, d.title, d.file_name,
  ${DOCUMENT_KIND_SQL} AS kind, coalesce(f.mime, d.mime) AS mime, coalesce(f.size, d.size) AS size,
  coalesce(f.url, d.url) AS url, d.local_path, ${PATH} AS path, ${MODIFIED} AS modified_at, d.updated_at,
  d.body IS NOT NULL AS has_text`

const str = (value: unknown) => (value == null ? null : String(value))
const num = (value: unknown) => (value == null ? null : Number(value))
const folderOf = (path: string | null) => {
  if (path === null) return null
  const slash = path.lastIndexOf("/")
  return slash <= 0 ? null : path.slice(0, slash)
}

const rowOf = (row: Record<string, unknown>): DocumentListRow => {
  const path = str(row.path)
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    provider: String(row.provider),
    account: String(row.account),
    accountName: str(row.account_name),
    title: str(row.title),
    fileName: str(row.file_name),
    kind: String(row.kind) as DocumentKind,
    mime: str(row.mime),
    size: num(row.size),
    url: str(row.url),
    localPath: str(row.local_path),
    path,
    folder: folderOf(path),
    modifiedAt: num(row.modified_at),
    storedAt: Number(row.updated_at),
    hasText: Number(row.has_text) === 1,
  }
}

const invalid = (message: string): never => {
  throw new CliError("validation_error", message)
}

/** The list's fields as the store answers them; `text` is searched before, and arrives as `ids`. */
const columns = (context: StoreContext): ColumnMap => {
  const { database } = context
  return {
    kind: { type: "enum", sql: DOCUMENT_KIND_SQL },
    source_modified_at: { type: "time", sql: MODIFIED },
    has_text: { type: "bool", sql: "(d.body IS NOT NULL)" },
    folder: {
      where: (node) => {
        const wanted = fold(node.value.replace(/^\/+|\/+$/gu, ""))
        // A folder holds what is in it and under it; GLOB keeps a `*` or `?` in a name literal.
        const literal = wanted.replace(/[*?[]/gu, (character) => `[${character}]`)
        return { sql: "(f.path_folded GLOB ? OR f.path_folded GLOB ?)", params: [`${literal}/*`, literal], known: true }
      },
    },
    tag: {
      where: (node) => ({
        sql:
          "EXISTS (SELECT 1 FROM taggings g JOIN resolved_tags t ON t.id = g.tag_id " +
          "WHERE g.taggable_type = 'document' AND g.taggable_id = d.id AND t.name = ?)",
        params: [canonicalTagNamed(database, node.value)?.name ?? normalizeTag(node.value)],
      }),
    },
    person: {
      where: (node) => {
        let found: ReturnType<typeof thingOf>
        try {
          found = thingOf(database, node.value.startsWith("person:") ? node.value : `person:${node.value}`)
        } catch {
          found = undefined
        }
        if (!found) return { sql: "0", params: [], known: true }
        return {
          sql:
            "EXISTS (SELECT 1 FROM links l WHERE l.from_type = 'document' AND l.from_id = d.id AND l.to_type = ? " +
            "AND l.to_id IN (SELECT value FROM json_each(?)))",
          params: [found.type, idsOf(database, found.type, found.id)],
        }
      },
    },
  }
}

const scoped = (filter: Pick<DocumentListFilter, "accountIds">, where: Where | undefined) => {
  const clauses = [LISTED]
  const params: SqlValue[] = []
  if (filter.accountIds !== undefined) {
    if (filter.accountIds.length === 0) invalid("accountIds names no account")
    clauses.push("d.account_id IN (SELECT value FROM json_each(?))")
    params.push(JSON.stringify(filter.accountIds))
  }
  if (where) {
    clauses.push(`(${where.sql})`)
    for (const param of where.params) params.push(param)
  }
  return { sql: clauses.join(" AND "), params }
}

const FROM = `FROM documents d JOIN accounts a ON a.id = d.account_id ${PREFERRED}`

const treeOf = (paths: Map<string, number>, depth: number): { loose: number; folders: DocumentFolderNode[] } => {
  const root: DocumentFolderNode = { name: "", path: "", count: 0, folders: [] }
  let loose = 0
  for (const [folder, count] of paths) {
    if (folder === "") {
      loose += count
      continue
    }
    let at = root
    const parts = folder.split("/")
    for (const [index, name] of parts.slice(0, depth).entries()) {
      const path = parts.slice(0, index + 1).join("/")
      let child = at.folders.find((one) => one.path === path)
      if (!child) {
        child = { name, path, count: 0, folders: [] }
        at.folders.push(child)
      }
      child.count += count
      at = child
    }
  }
  const sort = (nodes: DocumentFolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    for (const node of nodes) sort(node.folders)
  }
  sort(root.folders)
  return { loose, folders: root.folders }
}

export const documentListingOver = (context: StoreContext): DocumentListing => {
  const { database } = context
  const whereOf = (query: QueryAst | undefined, zone?: string, now?: number) =>
    query && queryFilter(query, columns(context), { ...(zone ? { zone } : {}), ...(now ? { now } : {}) })
  return {
    documentAccounts: async () =>
      database
        .prepare(
          `SELECT id, provider, external_id, name FROM accounts WHERE id IN (SELECT d.account_id FROM documents d ` +
            `WHERE ${LISTED}) ORDER BY provider, external_id`,
        )
        .all()
        .map(accountOf),
    documents: async (filter) => {
      if (!Number.isInteger(filter.limit) || filter.limit < 1 || !Number.isInteger(filter.offset) || filter.offset < 0)
        invalid("limit takes 1 or more and offset 0 or more")
      if (filter.ids?.length === 0) return { items: [], total: 0 }
      const where = scoped(filter, whereOf(filter.query, filter.zone, filter.now))
      // A text search's ids come ranked: joined as a table, their position orders the page.
      const from = filter.ids ? `${FROM} JOIN json_each(?) k ON k.value = d.id` : FROM
      const ranked = filter.ids ? [JSON.stringify(filter.ids)] : []
      const order = filter.ids ? "k.key" : `${MODIFIED} DESC, d.id DESC`
      return read(database, () => {
        // Counted apart: a window count would make SQLite build every row's columns before the page is cut.
        const total = Number(
          database.prepare(`SELECT count(*) AS n ${from} WHERE ${where.sql}`).get(...ranked, ...where.params)?.n,
        )
        const found = database
          .prepare(`SELECT ${COLUMNS} ${from} WHERE ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
          .all(...ranked, ...where.params, filter.limit, filter.offset)
        return { items: found.map(rowOf), total }
      })
    },
    documentSources: async ({ accountIds, depth }) => {
      const where = scoped({ ...(accountIds ? { accountIds } : {}) }, undefined)
      return read(database, () => {
        const rows = database
          .prepare(
            `SELECT d.account_id, a.provider, a.external_id AS account, a.name AS account_name, ${PATH} AS path ${FROM} ` +
              `WHERE ${where.sql}`,
          )
          .all(...where.params)
        const byAccount = new Map<number, { row: Record<string, unknown>; folders: Map<string, number> }>()
        for (const row of rows) {
          const id = Number(row.account_id)
          const held = byAccount.get(id) ?? { row, folders: new Map<string, number>() }
          byAccount.set(id, held)
          const folder = folderOf(str(row.path)) ?? ""
          held.folders.set(folder, (held.folders.get(folder) ?? 0) + 1)
        }
        return [...byAccount.entries()]
          .map(([accountId, { row, folders }]) => ({
            accountId,
            provider: String(row.provider),
            account: String(row.account),
            name: str(row.account_name),
            count: [...folders.values()].reduce((sum, count) => sum + count, 0),
            ...treeOf(folders, depth),
          }))
          .sort((a, b) => a.provider.localeCompare(b.provider) || a.account.localeCompare(b.account))
      })
    },
    document: async (id, { offset, limit }) =>
      read(database, () => {
        const row = database
          .prepare(
            `SELECT ${COLUMNS}, substr(d.body, ?, ?) AS text, length(d.body) AS text_length, d.extraction,
               d.extraction_error, d.language ${FROM} WHERE d.id = ? AND ${LISTED}`,
          )
          .get(offset + 1, limit, id)
        if (!row) return undefined
        const tags = database
          .prepare(
            "SELECT t.name FROM taggings g JOIN resolved_tags t ON t.id = g.tag_id " +
              "WHERE g.taggable_type = 'document' AND g.taggable_id = ? ORDER BY t.name",
          )
          .all(id)
          .map((tag) => String(tag.name))
        const people = database
          .prepare(
            "SELECT DISTINCT p.id, p.name, l.kind FROM links l JOIN persons p ON p.id = l.to_id " +
              "WHERE l.from_type = 'document' AND l.from_id = ? AND l.to_type = 'person' ORDER BY p.name, p.id",
          )
          .all(id)
          .map((person) => ({ ref: `person:${person.id}`, name: str(person.name), kind: String(person.kind) }))
        const meetings = database
          .prepare(
            "SELECT m.id, m.account_id, m.title, m.started_at, l.role FROM links l JOIN meetings m ON m.id = l.from_id " +
              "WHERE l.from_type = 'meeting' AND l.to_type = 'document' AND l.to_id = ? AND l.kind = 'attached' " +
              "AND m.deleted_at IS NULL ORDER BY m.started_at DESC, m.id",
          )
          .all(id)
          .map((meeting) => ({
            ref: `meeting:${meeting.account_id}/${meeting.id}`,
            title: str(meeting.title),
            at: num(meeting.started_at),
            role: str(meeting.role),
          }))
        const events = database
          .prepare(
            "SELECT DISTINCT e.id, e.title, e.starts_at FROM links l JOIN calendar_entries ce ON ce.id = l.from_id " +
              "JOIN events e ON e.id = ce.event_id WHERE l.from_type = 'calendar_entry' AND l.to_type = 'document' " +
              "AND l.to_id = ? AND l.kind = 'attached' AND e.deleted_at IS NULL ORDER BY e.starts_at DESC, e.id",
          )
          .all(id)
          .map((event) => ({ ref: `event:${event.id}`, title: str(event.title), at: num(event.starts_at), role: null }))
        return {
          ...rowOf(row),
          text: str(row.text),
          textLength: Number(row.text_length ?? 0),
          extraction: str(row.extraction),
          extractionError: str(row.extraction_error),
          language: str(row.language),
          tags,
          people,
          meetings,
          events,
        }
      }),
  }
}
