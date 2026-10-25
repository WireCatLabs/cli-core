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
const logLink = (database: CacheDatabase, now: number, fileId: number, from: unknown, to: number) =>
  database
    .prepare(
      "INSERT INTO entity_link_events (linkable_type, linkable_id, entity_type, from_entity_id, to_entity_id, method, " +
        "confidence, author, created_at) VALUES ('file', ?, 'document', ?, ?, 'import', 1, 'rules', ?)",
    )
    .run(fileId, from == null ? null : Number(from), to, now)

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
 */
export const syncFile = (
  database: CacheDatabase,
  now: number,
  documentId: number,
  { seen = true, depth = 0 }: { seen?: boolean; depth?: number } = {},
): Placed | null => {
  const doc = database.prepare("SELECT * FROM documents WHERE id = ?").get(documentId) as Row | undefined
  if (!doc) return null
  const accountId = Number(doc.account_id)
  const front = objectOf(doc.front_matter)
  const catalog = objectOf(objectOf(doc.metadata)?.catalog)
  const provider = database.prepare("SELECT provider FROM accounts WHERE id = ?").get(accountId)?.provider
  // A vault file may carry an exported Drive file's front matter and still be a file on disk.
  const remote = catalog !== undefined || (front?.source === "google-drive" && !LOCAL.has(String(provider)))
  const externalId = (remote && stringOf(front?.fileId)) || String(doc.external_id)
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
    const path = String(doc.external_id)
    name = nameOf(path)
    const slash = path.lastIndexOf("/")
    parent = localFolder(database, now, accountId, slash < 0 ? "" : path.slice(0, slash))
    metadata = front === undefined ? {} : { front_matter: front }
  }
  const path = remote ? (parent ? `${parent.path}/${name}` : name) : String(doc.external_id)
  const existing = (database.prepare("SELECT * FROM files WHERE document_id = ?").get(documentId) ??
    database.prepare("SELECT * FROM files WHERE account_id = ? AND external_id = ?").get(accountId, externalId)) as
    | Row
    | undefined
  const gone = doc.deleted_at != null ? Number(doc.deleted_at) : catalog?.active === false ? now : null
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
    content_hash: doc.content_hash ?? null,
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
    logLink(database, now, placed.id, null, documentId)
    if (remote && kind === "folder") placeChildren(database, now, accountId, String(doc.external_id), depth)
    return placed
  }
  const id = Number(existing.id)
  if (existing.document_id !== documentId) logLink(database, now, id, existing.document_id, documentId)
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

export interface FilesStore {
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

export const filesStoreOver = ({ database, now }: { database: CacheDatabase; now: () => number }): FilesStore => ({
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
})
