import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"
import { fold } from "../normalize.js"
import { write, writeBatch } from "./transaction.js"

type Row = Record<string, unknown>

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** A JSON column's object, or an object already parsed out of one. */
const objectOf = (value: unknown): Record<string, unknown> | undefined => {
  if (isObject(value)) return value
  if (typeof value !== "string") return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const stringOf = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)

const timeOf = (value: unknown): number | null => {
  const text = stringOf(value)
  const at = text === undefined ? Number.NaN : Date.parse(text)
  return Number.isFinite(at) ? at : null
}

const LOCAL = new Set(["local", "obsidian"])

/** A local file of a document, where it is and its own facts. */
export interface LocalPlace {
  accountId: number
  path: string
  contentHash: string | null
  frontMatter: unknown
}

/** Nested Drive folders deeper than this are cut at the root: a parent cycle must not recurse forever. */
const MAX_DEPTH = 64

interface Placed {
  id: number
  path: string
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** A local folder's own row, and its parents', made when a file under it is first written. */
const localFolder = (database: CacheDatabase, now: number, accountId: number, path: string): Placed | null => {
  if (!path) return null
  const found = database
    .prepare("SELECT id, path FROM files WHERE account_id = ? AND external_id = ? AND kind = 'folder'")
    .get(accountId, path)
  if (found) return { id: Number(found.id), path: String(found.path) }
  const slash = path.lastIndexOf("/")
  const parent = localFolder(database, now, accountId, slash < 0 ? "" : path.slice(0, slash))
  const row = database
    .prepare(
      "INSERT INTO files (account_id, external_id, kind, name, path, path_folded, parent_id, created_at, updated_at) " +
        "VALUES (?, ?, 'folder', ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get(accountId, path, nameOf(path), path, fold(path), parent?.id ?? null, now, now)
  return { id: Number(row?.id), path }
}

/** A file's document is the one its writer saved it as (`import`); a change of it is logged as every link is. */
export const logFileLink = (
  database: CacheDatabase,
  now: number,
  fileId: number,
  from: unknown,
  to: number | null,
  method = "import",
  author = "rules",
) =>
  database
    .prepare(
      "INSERT INTO entity_link_events (linkable_type, linkable_id, entity_type, from_entity_id, to_entity_id, method, " +
        "confidence, author, created_at) VALUES ('file', ?, 'document', ?, ?, ?, 1, ?, ?)",
    )
    .run(fileId, from == null ? null : Number(from), to, method, author, now)

/** How an `attached` link names a Drive file it waits for: by its Drive id, since no row may hold it yet. */
export const driveFileTarget = (fileId: string): string => `google-drive:${fileId}`

/** The document of the Drive file with this id; `null` when no Drive account holds it, or two do. */
export const driveDocumentOf = (database: CacheDatabase, fileId: string): number | null => {
  const rows = database
    .prepare(
      "SELECT DISTINCT f.document_id AS id FROM files f JOIN accounts a ON a.id = f.account_id WHERE a.provider = 'google-drive' " +
        "AND f.external_id = ? AND f.deleted_at IS NULL AND f.document_id IS NOT NULL LIMIT 2",
    )
    .all(fileId)
  return rows.length === 1 ? Number(rows[0]?.id) : null
}

/** Calendar entries that named this Drive file before Drive stored it now link its document. */
const linkAttached = (database: CacheDatabase, now: number, fileId: string): void => {
  const target = driveFileTarget(fileId)
  if (
    !database
      .prepare(
        "SELECT 1 FROM links WHERE to_type = 'document' AND to_id IS NULL AND target_text = ? AND kind = 'attached'",
      )
      .get(target)
  )
    return
  const document = driveDocumentOf(database, fileId)
  if (document !== null)
    database
      .prepare(
        "UPDATE links SET to_id = ?, updated_at = ? WHERE to_type = 'document' AND to_id IS NULL AND target_text = ? " +
          "AND kind = 'attached'",
      )
      .run(document, now, target)
}

/** Moves the rows under a folder whose path changed, in one statement over the old prefix. */
const movePaths = (database: CacheDatabase, accountId: number, from: string, to: string): void => {
  database
    .prepare(
      "UPDATE files SET path = ? || substr(path, ?), path_folded = NULL WHERE account_id = ? AND substr(path, 1, ?) = ?",
    )
    .run(to, from.length + 1, accountId, from.length + 1, `${from}/`)
}

/**
 * Writes the `files` row of one document from the document as it is now: the document's source record. A Drive
 * document (catalog metadata or Drive front matter) is keyed by its Drive file id and placed under its first parent;
 * a local one by its path, under folder rows made from that path. `seen` marks a sync or import that returned it.
 * `place` names a local file of the document other than the one its own columns name: a copy in another folder.
 */
export const syncFile = (
  database: CacheDatabase,
  now: number,
  documentId: number,
  {
    seen = true,
    depth = 0,
    place,
    method = "import",
  }: { seen?: boolean; depth?: number; place?: LocalPlace; method?: string } = {},
): Placed | null => {
  const doc = database.prepare("SELECT * FROM documents WHERE id = ?").get(documentId) as Row | undefined
  if (!doc) return null
  const accountId = place?.accountId ?? Number(doc.account_id)
  const front = place ? objectOf(place.frontMatter) : objectOf(doc.front_matter)
  const catalog = place ? undefined : objectOf(objectOf(doc.metadata)?.catalog)
  const provider = database.prepare("SELECT provider FROM accounts WHERE id = ?").get(accountId)?.provider
  // A vault file may carry an exported Drive file's front matter and still be a file on disk.
  const remote = catalog !== undefined || (front?.source === "google-drive" && !LOCAL.has(String(provider)))
  const externalId = (remote && stringOf(front?.fileId)) || (place?.path ?? String(doc.external_id))
  const kind = doc.kind === "folder" ? "folder" : doc.kind === "page" ? "page" : "file"
  let name: string
  let parent: Placed | null = null
  let metadata: Record<string, unknown>
  if (remote) {
    name = stringOf(catalog?.name) ?? stringOf(doc.title) ?? externalId
    const parents = Array.isArray(catalog?.parents) ? catalog.parents.filter((one) => typeof one === "string") : []
    const first = parents[0]
    if (first !== undefined && depth < MAX_DEPTH) {
      const above = database
        .prepare("SELECT id FROM documents WHERE account_id = ? AND external_id = ?")
        .get(accountId, first)
      if (above && Number(above.id) !== documentId)
        parent = syncFile(database, now, Number(above.id), { seen: false, depth: depth + 1 })
    }
    const version = front?.sourceVersion
    metadata = {
      ...(version === undefined || version === null ? {} : { version }),
      ...(parents.length > 1 ? { parents } : {}),
    }
  } else {
    const path = place?.path ?? String(doc.external_id)
    name = nameOf(path)
    const slash = path.lastIndexOf("/")
    parent = localFolder(database, now, accountId, slash < 0 ? "" : path.slice(0, slash))
    metadata = front === undefined ? {} : { front_matter: front }
  }
  const path = remote ? (parent ? `${parent.path}/${name}` : name) : (place?.path ?? String(doc.external_id))
  // The place first; then, for a Drive file first saved under its document's own key, that row (`<id>.md`).
  const existing = (database
    .prepare("SELECT * FROM files WHERE account_id = ? AND external_id = ?")
    .get(accountId, place?.path ?? externalId) ??
    (place
      ? undefined
      : database
          .prepare("SELECT * FROM files WHERE document_id = ? AND account_id = ? AND external_id = ?")
          .get(documentId, accountId, String(doc.external_id)))) as Row | undefined
  const gone = place ? null : doc.deleted_at != null ? Number(doc.deleted_at) : catalog?.active === false ? now : null
  const values = {
    account_id: accountId,
    external_id: externalId,
    kind,
    name,
    path,
    path_folded: fold(path),
    parent_id: parent?.id ?? null,
    document_id: documentId,
    mime: doc.mime ?? (remote ? (stringOf(front?.mime) ?? null) : null),
    size: doc.size ?? (remote && Number.isSafeInteger(front?.size) ? front?.size : null),
    content_hash: place ? place.contentHash : (doc.content_hash ?? null),
    url: doc.url ?? (remote ? (stringOf(front?.sourceUrl) ?? null) : null),
    external_created_at: doc.external_created_at ?? null,
    external_updated_at: doc.external_updated_at ?? (remote ? timeOf(front?.modifiedAt) : null),
    metadata: Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    seen_at: seen ? now : (existing?.seen_at ?? timeOf(catalog?.observedAt)),
    deleted_at: gone === null ? null : existing?.deleted_at != null ? Number(existing.deleted_at) : gone,
  }
  if (!existing) {
    const columns = Object.keys(values)
    const row = database
      .prepare(
        `INSERT INTO files (${columns.join(", ")}, created_at, updated_at) VALUES (${columns.map(() => "?").join(", ")}, ?, ?) RETURNING id`,
      )
      .get(...(Object.values(values) as (string | number | null)[]), Number(doc.created_at), now)
    const placed = { id: Number(row?.id), path }
    logFileLink(database, now, placed.id, null, documentId, method)
    if (remote) linkAttached(database, now, externalId)
    if (remote && kind === "folder") placeChildren(database, now, accountId, String(doc.external_id), depth)
    return placed
  }
  const id = Number(existing.id)
  if (existing.document_id !== documentId) logFileLink(database, now, id, existing.document_id, documentId, method)
  const changed = Object.entries(values).some(([key, value]) => key !== "seen_at" && existing[key] !== value)
  if (changed || values.seen_at !== existing.seen_at) {
    database
      .prepare(
        `UPDATE files SET ${Object.keys(values)
          .map((key) => `${key} = ?`)
          .join(", ")}, updated_at = ? WHERE id = ?`,
      )
      .run(...(Object.values(values) as (string | number | null)[]), changed ? now : Number(existing.updated_at), id)
    if (kind === "folder" && existing.path !== path) movePaths(database, accountId, String(existing.path), path)
    if (remote && changed) linkAttached(database, now, externalId)
  }
  return { id, path }
}

/** A Drive item written before its folder sat at the root; the folder's first write puts it under it. */
const placeChildren = (database: CacheDatabase, now: number, accountId: number, folder: string, depth: number) => {
  const orphans = database
    .prepare(
      "SELECT d.id FROM documents d JOIN files f ON f.document_id = d.id WHERE d.account_id = ? AND f.parent_id IS NULL " +
        "AND json_valid(d.metadata) AND json_extract(d.metadata, '$.catalog.parents[0]') = ?",
    )
    .all(accountId, folder)
  for (const row of orphans) syncFile(database, now, Number(row.id), { seen: false, depth: depth + 1 })
}

export const FILES_BACKFILL = "files_backfill_after"

/**
 * Writes the `files` row of every document stored before version 32, from the document after the cursor the
 * migration left, in short writes: another process waits for one batch at most, and a stop resumes where it was.
 */
export const fillFiles = (database: CacheDatabase, now: () => number, { batch = 500 } = {}): number => {
  const cursor = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(FILES_BACKFILL)
  if (!cursor) return 0
  let after = Number(cursor.value)
  let filled = 0
  const next = database.prepare("SELECT id FROM documents WHERE id > ? ORDER BY id LIMIT ?")
  for (;;) {
    const ids = writeBatch(database, () => {
      const page = next.all(after, batch).map((row) => Number(row.id))
      const at = now()
      for (const id of page) syncFile(database, at, id, { seen: false })
      if (page.length < batch) database.prepare("DELETE FROM store_settings WHERE key = ?").run(FILES_BACKFILL)
      else
        database
          .prepare("UPDATE store_settings SET value = ?, at = ? WHERE key = ?")
          .run(String(page.at(-1)), at, FILES_BACKFILL)
      return page
    })
    filled += ids.length
    if (ids.length < batch) return filled
    after = ids.at(-1) as number
  }
}

/** A source record of a document: one item in one place (`files` row). Times are ISO 8601. */
export interface StoredFile {
  id: string
  accountId: string
  externalId: string
  kind: "file" | "folder" | "page"
  name: string
  path: string
  parentId: string | null
  /** `document:<id>`, or `null` for a local folder. */
  document: string | null
  mime: string | null
  size: number | null
  contentHash: string | null
  url: string | null
  externalCreatedAt: string | null
  externalUpdatedAt: string | null
  metadata: Record<string, unknown> | null
  seenAt: string | null
  deletedAt: string | null
}

export interface FileListQuery {
  /** Everything at and below this folder path, from the account root. */
  under?: string
  /** Paths holding this text, in any case and accent. */
  pathContains?: string
  kind?: StoredFile["kind"]
  includeDeleted?: boolean
  limit?: number
  offset?: number
}

export interface FilesStore {
  /** The files of one account, by path. The account is always named: there is no default place. */
  list(accountId: string, query?: FileListQuery): Promise<{ items: StoredFile[]; hasMore: boolean }>
  byPath(accountId: string, path: string): Promise<StoredFile | undefined>
  /** Every place a document is kept, the one it shows first: the owner's pin, else the most recently changed. */
  ofDocument(reference: string): Promise<StoredFile[]>
  /** The owner's choice of the file a document shows (`document:<id>`, a file id of that document). */
  pin(document: string, fileId: string): Promise<void>
  /** The document shows its most recently changed file again. */
  unpin(document: string): Promise<void>
}

const documentIdOf = (reference: string): number => {
  const id = /^(?:document:)?(\d+)$/u.exec(reference)?.[1]
  if (id === undefined) throw new CliError("validation_error", `${reference} is not a document reference`)
  return Number(id)
}

const isoOrNull = (value: unknown) => (value == null ? null : new Date(Number(value)).toISOString())
const idOrNull = (value: unknown) => (value == null ? null : String(value))

export const fileOf = (row: Row): StoredFile => ({
  id: String(row.id),
  accountId: String(row.account_id),
  externalId: String(row.external_id),
  kind: row.kind as StoredFile["kind"],
  name: String(row.name),
  path: String(row.path),
  parentId: idOrNull(row.parent_id),
  document: row.document_id == null ? null : `document:${row.document_id}`,
  mime: idOrNull(row.mime),
  size: row.size == null ? null : Number(row.size),
  contentHash: idOrNull(row.content_hash),
  url: idOrNull(row.url),
  externalCreatedAt: isoOrNull(row.external_created_at),
  externalUpdatedAt: isoOrNull(row.external_updated_at),
  metadata: objectOf(row.metadata) ?? null,
  seenAt: isoOrNull(row.seen_at),
  deletedAt: isoOrNull(row.deleted_at),
})

/**
 * The file a document shows (requirements 3.3): live ones first, then the owner's pin, then the most recently changed.
 * Read with the document's row joined as `d`.
 */
export const PREFERRED_FILE =
  "f.deleted_at IS NOT NULL, f.id IS NOT d.pinned_file_id, coalesce(f.external_updated_at, f.updated_at) DESC, f.id DESC"

export const filesStoreOver = ({ database, now }: { database: CacheDatabase; now: () => number }): FilesStore => {
  const account = (id: string) => {
    if (!/^\d+$/.test(id) || !database.prepare("SELECT 1 FROM accounts WHERE id = ?").get(Number(id)))
      throw new CliError("not_found", `no account ${id} in the local store`)
    return Number(id)
  }
  return {
    list: async (accountId, query = {}) => {
      const { limit = 100, offset = 0 } = query
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0)
        throw new CliError("validation_error", "limit takes 1–1000 and offset 0 or more")
      const clauses = ["f.account_id = ?"]
      const params: (string | number)[] = [account(accountId)]
      if (!query.includeDeleted) clauses.push("f.deleted_at IS NULL")
      if (query.kind !== undefined) {
        clauses.push("f.kind = ?")
        params.push(query.kind)
      }
      if (query.under !== undefined) {
        const prefix = fold(query.under.replace(/\/+$/u, ""))
        // `/` sorts just before `0`, so the subtree is one range over the index.
        clauses.push("(f.path_folded = ? OR (f.path_folded >= ? AND f.path_folded < ?))")
        params.push(prefix, `${prefix}/`, `${prefix}0`)
      }
      if (query.pathContains !== undefined) {
        clauses.push("instr(f.path_folded, ?) > 0")
        params.push(fold(query.pathContains))
      }
      const rows = database
        .prepare(`SELECT f.* FROM files f WHERE ${clauses.join(" AND ")} ORDER BY f.path_folded, f.id LIMIT ? OFFSET ?`)
        .all(...params, limit + 1, offset)
      return { items: rows.slice(0, limit).map(fileOf), hasMore: rows.length > limit }
    },
    byPath: async (accountId, path) => {
      const row = database
        .prepare("SELECT * FROM files WHERE account_id = ? AND path = ? ORDER BY deleted_at IS NOT NULL, id LIMIT 1")
        .get(account(accountId), path)
      return row ? fileOf(row) : undefined
    },
    ofDocument: async (reference) =>
      database
        .prepare(
          `SELECT f.* FROM files f JOIN documents d ON d.id = f.document_id WHERE f.document_id = ? ORDER BY ${PREFERRED_FILE}`,
        )
        .all(documentIdOf(reference))
        .map(fileOf),
    pin: async (document, fileId) =>
      write(database, () => {
        const id = documentIdOf(document)
        const file = /^\d+$/u.test(fileId)
          ? database.prepare("SELECT id FROM files WHERE id = ? AND document_id = ?").get(Number(fileId), id)
          : undefined
        if (!file) throw new CliError("not_found", `file ${fileId} is not a file of ${document}`)
        database
          .prepare("UPDATE documents SET pinned_file_id = ?, updated_at = ? WHERE id = ?")
          .run(Number(fileId), now(), id)
      }),
    unpin: async (document) =>
      write(database, () => {
        const id = documentIdOf(document)
        if (!database.prepare("SELECT 1 FROM documents WHERE id = ?").get(id))
          throw new CliError("not_found", `no ${document} in the local store`)
        database.prepare("UPDATE documents SET pinned_file_id = NULL, updated_at = ? WHERE id = ?").run(now(), id)
      }),
  }
}
