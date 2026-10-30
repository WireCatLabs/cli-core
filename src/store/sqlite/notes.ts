import { CliError } from "@wirecat/cli-base"
import { MAX_TEXT_CHARS } from "../../attachments/limits.js"
import { googleDocumentLinks } from "../../domain/google-documents.js"
import {
  DOCUMENT_ACCOUNT_PROVIDERS,
  filesAccountSql,
  folderProviderOf,
  folderProviderSql,
  isDocumentAccountProvider,
} from "../../domain/providers.js"
import { parseReference } from "../../domain/references.js"
import { normalizeTag } from "../../domain/tags.js"
import type { Section } from "../../readers/types.js"
import type { CacheDatabase, CacheStatement } from "../driver.js"
import { fold } from "../normalize.js"
import { ulid } from "../ulid.js"
import { ownerPerson } from "./actors.js"
import { type DocumentMetadata, encodeDocumentMetadata, languageOf } from "./document-metadata.js"
import { PREFERRED_FILE, syncFile } from "./files.js"
import { type ImportedDocuments, importedDocumentWhere } from "./imported-documents.js"
import { LINK_KINDS, LINK_ORIGINS, type LINK_SOURCES, linkKind } from "./link-kinds.js"
import { reviewLink } from "./link-reviews.js"
import { holdingText } from "./note-index.js"
import type { NoteSearch } from "./note-search.js"
import type { StoreContext } from "./open.js"
import { addTags, ensureTag, type Label, labelsOf } from "./tags.js"
import { canonicalThingReference, referenceOfThing, storedThing, type Thing, thingOf } from "./things.js"
import { write } from "./transaction.js"

export const NOTE_FORMATS = ["obsidian", "markdown"] as const
export { LINK_ORIGINS } from "./link-kinds.js"

/**
 * A notes folder: an `accounts` row of provider `local` or `obsidian`. Where it is on disk is this computer's config. A
 * documents account (Drive's, one per Google account) is read and written the same way and names its `account`.
 */
export interface NoteFolder {
  id: string
  name: string
  /** `obsidian` for a vault, `local` for a plain folder; `folder` for Drive's stand-in folders from before. */
  provider: string
  format: (typeof NOTE_FORMATS)[number]
  createdAt: string
  account?: { provider: string; account: string }
}

/**
 * A file in a notes folder (a `documents` row, `source` file) or a note the owner wrote (a `notes` row,
 * `source` internal). Their ids overlap, so `ref` — `document:<id>` or `note:<id>` — is what names one.
 */
export interface Note {
  id: string
  ref: string
  source: "file" | "internal"
  folderId: string | null
  path: string | null
  title: string | null
  text: string
  frontMatter: unknown
  contentHash: string | null
  revision: number
  exportPath: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface Link {
  id: string
  from: string
  /** `null` while the link names nobody the store knows, or more than one. */
  to: string | null
  kind: (typeof LINK_KINDS)[number]
  anchor: string | null
  origin: (typeof LINK_SOURCES)[number]
  targetText: string | null
  role: string | null
  evidence: string | null
  provenance: string | null
  confirmed: boolean
  createdAt: string
}

export interface LinkListFilter {
  from?: string
  to?: string
  unresolved?: boolean
  id?: string
  kind?: Link["kind"]
  role?: string
  origin?: Link["origin"]
  confirmed?: boolean
}

export interface LinkInput {
  from: string
  to?: string
  targetText?: string
  kind: Link["kind"]
  anchor?: string
  origin?: (typeof LINK_ORIGINS)[number]
  role?: string
  evidence?: string
  provenance?: string
  confirmed?: boolean
}

export interface FileNoteInput {
  folderId: string
  path: string
  title: string | null
  text: string
  frontMatter?: unknown
  contentHash?: string | null
  /** What a reader found in the file: title, site, author, language, keywords; searched as `site:`, `lang:`, … */
  metadata?: DocumentMetadata
  /** Headings of the text, as readers give them; meaning search cuts its chunks at their starts. */
  sections?: Section[]
}

export type NoteTag = Label

/** A stored document and the Google file id its links carry. */
export interface MessageDocument {
  /** `document:<id>`, as `drive documents show` takes it. */
  reference: string
  fileId: string
}

export interface NotesStore extends NoteSearch, ImportedDocuments {
  addFolder(input: { name: string; format?: NoteFolder["format"] }): Promise<NoteFolder>
  /** The notes folders only; a documents account is not one (`documentsAccounts`). */
  folders(): Promise<NoteFolder[]>
  /** One documents account by its key (`{ provider: "google-drive", account: <principal> }`), created when asked. */
  documentsAccount(key: { provider: string; account: string }, create?: boolean): Promise<NoteFolder | undefined>
  /** Every documents account the store holds, by provider then account. */
  documentsAccounts(): Promise<NoteFolder[]>
  saveFileNote(input: FileNoteInput): Promise<{ note: Note; changed: boolean }>
  /** Moves a file note to a new path in its folder, keeping its id, links and tags; a gone note at `to` is dropped. */
  renameFileNote(folderId: string, from: string, to: string): Promise<Note>
  /** Marks the folder's notes at these paths deleted; answers how many were live. */
  deleteFileNotes(folderId: string, paths: string[]): Promise<number>
  /** A note about the things named, the first of them its subject; about nothing, a note to self. */
  addNote(input: { text: string; title?: string; about?: string[] }): Promise<Note>
  /** By reference (`note:12`, `document:5`); a bare id is a note's. */
  note(reference: string): Promise<Note>
  resolveNote(reference: string): Promise<Note | undefined>
  noteReferences(reference: string): Promise<string[]>
  notes(options?: {
    folderId?: string
    source?: Note["source"]
    about?: string
    search?: string
    limit?: number
    offset?: number
  }): Promise<{ items: Note[]; hasMore: boolean }>
  editNote(id: string, text: string, revision: number): Promise<Note>
  removeNote(id: string): Promise<{ id: string; removed: true }>
  addLink(input: LinkInput): Promise<Link>
  links(options?: LinkListFilter): Promise<Link[]>
  removeLink(id: string): Promise<{ id: string; removed: true }>
  /** The links a file states, replacing what its last import stated; links the owner added stay. */
  replaceFileLinks(documentId: string, links: Omit<LinkInput, "from" | "origin">[]): Promise<Link[]>
  /**
   * Links every stored message whose text holds a Google link to one of the documents, in any account; a link
   * already there is kept, not doubled. `since` (ISO 8601) includes messages stored or locally revised at or after it.
   * Answers how many links it added.
   */
  linkMessages(input: { documents: MessageDocument[]; since?: string }): Promise<number>
  /**
   * The tags a file states, replacing what its last import stated. A tag the owner added stays, even when
   * the file stops stating it; a file tag the owner also added becomes the owner's.
   */
  replaceFileTags(documentId: string, tags: string[]): Promise<NoteTag[]>
  noteTags(reference: string): Promise<NoteTag[]>
  /** Tries every unresolved link against the people known now; answers how many it resolved. */
  resolveLinks(): Promise<number>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => new Date(Number(value)).toISOString()
const optionalIso = (value: unknown) => (value == null ? null : iso(value))

const textOf = (text: string, what: string, max = 100_000, allowEmpty = false) => {
  const value = text.trim()
  if ((!value && !allowEmpty) || value.length > max)
    throw new CliError("validation_error", `${what} takes ${allowEmpty ? 0 : 1}–${max} characters`)
  return value
}

const oneOf = <T extends string>(value: string, allowed: readonly T[], what: string): T => {
  if (!allowed.includes(value as T)) throw new CliError("validation_error", `${what} is one of ${allowed.join(", ")}`)
  return value as T
}

/** What a link's written target is matched by: case, accents and a leading `@` do not count. */
export const targetKey = (text: string): string => fold(text).trim().replace(/^@/, "")

export const documentOf = (row: Row): Note => ({
  id: String(row.id),
  ref: `document:${row.id}`,
  source: "file",
  folderId: String(row.account_id),
  path: String(row.external_id),
  title: row.title == null ? null : String(row.title),
  text: String(row.body ?? ""),
  frontMatter: row.front_matter == null ? null : JSON.parse(String(row.front_matter)),
  contentHash: row.content_hash == null ? null : String(row.content_hash),
  revision: Number(row.revision),
  exportPath: row.export_path == null ? null : String(row.export_path),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  deletedAt: optionalIso(row.deleted_at),
})

export const noteOf = (row: Row): Note => ({
  id: String(row.id),
  ref: `note:${row.id}`,
  source: "internal",
  folderId: null,
  path: null,
  title: row.title == null ? null : String(row.title),
  text: String(row.body),
  frontMatter: null,
  contentHash: null,
  revision: Number(row.revision),
  exportPath: null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  deletedAt: optionalIso(row.deleted_at),
})

/** A document or note row by its typed reference, or `undefined`. */
export const noteRowOf = (database: CacheDatabase, reference: string): Note | undefined => {
  const thing = thingOf(database, reference.includes(":") ? reference : `note:${reference}`)
  if (thing?.type === "document")
    return documentOf(database.prepare("SELECT * FROM documents WHERE id = ?").get(thing.id) as Row)
  if (thing?.type === "note") return noteOf(database.prepare("SELECT * FROM notes WHERE id = ?").get(thing.id) as Row)
  return undefined
}

const thingRef = (database: CacheDatabase, type: unknown, id: unknown): string | null =>
  type == null || id == null ? null : (referenceOfThing(database, storedThing(type, id)) ?? null)

export const linkOf = (database: CacheDatabase, row: Row): Link => {
  const metadata = row.metadata == null ? {} : (JSON.parse(String(row.metadata)) as { provenance?: string })
  return {
    id: String(row.id),
    from: thingRef(database, row.from_type, row.from_id) as string,
    to: thingRef(database, row.to_type, row.to_id),
    kind: row.kind as Link["kind"],
    anchor: row.anchor == null ? null : String(row.anchor),
    origin: row.source as Link["origin"],
    targetText: row.target_text == null ? null : String(row.target_text),
    role: row.role == null ? null : String(row.role),
    evidence: row.evidence == null ? null : String(row.evidence),
    provenance: metadata.provenance ?? null,
    confirmed: Number(row.confirmed) === 1,
    createdAt: iso(row.created_at),
  }
}

/** The row a reference names, refused when the store holds none. */
export const requiredThing = (database: CacheDatabase, reference: string, what = "the target"): Thing => {
  const thing = thingOf(database, canonicalThingReference(reference))
  if (!thing) throw new CliError("not_found", `${what} ${reference} is not in the local store`)
  return thing
}

/** The people a written name points at: by name or username of any identity, or by an alias. */
const personsNamed = (database: CacheDatabase, key: string): Set<number> => {
  const found = new Set<number>()
  if (key.length >= 3) {
    const rows = database
      .prepare(
        "SELECT i.name, i.username, il.person_id FROM identities_fts f JOIN identities i ON i.id = f.rowid " +
          "JOIN identity_links il ON il.identity_id = i.id WHERE identities_fts MATCH ?",
      )
      .all(`"${key.replaceAll('"', '""')}"`)
    for (const row of rows) {
      const names = [row.name, row.username].filter((one) => one != null).map((one) => targetKey(String(one)))
      if (names.includes(key)) found.add(Number(row.person_id))
    }
  }
  const aliases = database
    .prepare(
      "SELECT coalesce(il.person_id, CASE WHEN a.aliasable_type = 'person' THEN a.aliasable_id END) AS person_id " +
        "FROM aliases a LEFT JOIN identity_links il ON a.aliasable_type = 'identity' AND il.identity_id = a.aliasable_id " +
        "WHERE a.name_folded = ? OR a.name = ?",
    )
    .all(key, key)
  for (const row of aliases) if (row.person_id != null) found.add(Number(row.person_id))
  return found
}

const resolveKey = (database: CacheDatabase, key: string): number => {
  const people = personsNamed(database, key)
  if (people.size !== 1) return 0
  return database
    .prepare("UPDATE links SET to_type = 'person', to_id = ? WHERE to_id IS NULL AND target_folded = ?")
    .run([...people][0] as number, key).changes
}

const unresolvedChecks = new WeakMap<CacheDatabase, CacheStatement>()

/**
 * Called in the write that creates or renames a person, or gives them an alias: one indexed lookup,
 * and only a name some note is waiting for costs more.
 */
export const resolvePersonLinks = (database: CacheDatabase, names: (string | null | undefined)[]): void => {
  const keys = [...new Set(names.filter((name): name is string => !!name?.trim()).map(targetKey))]
  if (keys.length === 0) return
  let check = unresolvedChecks.get(database)
  if (!check) {
    check = database.prepare("SELECT 1 FROM links WHERE to_id IS NULL AND target_folded = ? LIMIT 1")
    unresolvedChecks.set(database, check)
  }
  for (const key of keys) if (check.get(key)) resolveKey(database, key)
}

/** Writes one link; an identical resolved link is answered instead of doubled. */
export const insertLink = (context: StoreContext, input: LinkInput): Link => {
  const { database, now } = context
  const kind = oneOf(input.kind, LINK_KINDS, "a link's kind")
  if (kind === "blocked-by" || kind === "follow-up-of")
    throw new CliError("validation_error", "use tasks.linkTask for validated task dependencies")
  const origin = oneOf(input.origin ?? "owner", LINK_ORIGINS, "a link's origin")
  const from = requiredThing(database, input.from, "a link's source")
  const to = input.to === undefined ? null : requiredThing(database, input.to, "a link's target")
  const targetText = input.targetText === undefined ? null : textOf(input.targetText, "a link's target", 500)
  if (to === null && targetText === null) throw new CliError("validation_error", "a link needs a target")
  if (to !== null) {
    const existing = database
      .prepare(
        "SELECT * FROM links WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND kind = ? AND anchor IS ?",
      )
      .get(from.type, from.id, to.type, to.id, kind, input.anchor ?? null)
    if (existing) return linkOf(database, existing)
  }
  const at = now()
  const provenance = input.provenance === undefined ? undefined : textOf(input.provenance, "provenance", 2000)
  const row = database
    .prepare(
      "INSERT INTO links (from_type, from_id, to_type, to_id, kind, anchor, source, target_text, target_folded, role, evidence, " +
        "metadata, confirmed, created_at, author, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get(
      from.type,
      from.id,
      to?.type ?? null,
      to?.id ?? null,
      kind,
      input.anchor ?? null,
      origin,
      targetText,
      targetText === null ? null : targetKey(targetText),
      input.role === undefined ? null : textOf(input.role, "a role", 200),
      input.evidence === undefined ? null : textOf(input.evidence, "evidence", 2000),
      provenance === undefined ? null : JSON.stringify({ provenance }),
      input.confirmed === false ? 0 : 1,
      at,
      origin === "owner" ? "owner" : null,
      at,
    )
  if (to === null && targetText !== null) resolveKey(database, targetKey(targetText))
  return linkOf(database, database.prepare("SELECT * FROM links WHERE id = ?").get(Number(row?.id)) as Row)
}

/** A folder's `accounts` row; its format lives in `settings`. */
const folderOf = (row: Row): NoteFolder => {
  const settings = row.settings == null ? {} : (JSON.parse(String(row.settings)) as { format?: string })
  const folder = !isDocumentAccountProvider(String(row.provider))
  return {
    id: String(row.id),
    name: folder ? String(row.name) : `${String(row.provider)}:${String(row.external_id)}`,
    provider: String(row.provider),
    format: (settings.format ?? (folder ? "obsidian" : "markdown")) as NoteFolder["format"],
    createdAt: iso(row.created_at),
    ...(folder ? {} : { account: { provider: String(row.provider), account: String(row.external_id) } }),
  }
}

const frontMatterObject = (text: unknown): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(String(text))
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const frontMatterOf = (metadata: unknown): unknown => {
  try {
    return (JSON.parse(String(metadata)) as { front_matter?: unknown } | null)?.front_matter ?? null
  } catch {
    return null
  }
}

const pathParts = (path: string) => {
  const slash = path.lastIndexOf("/")
  const fileName = slash < 0 ? path : path.slice(slash + 1)
  const dot = fileName.lastIndexOf(".")
  return {
    location: slash < 0 ? null : path.slice(0, slash),
    fileName,
    extension: dot <= 0 ? null : fileName.slice(dot + 1).toLowerCase(),
  }
}

export const notesStoreOver = (context: StoreContext): Omit<NotesStore, keyof NoteSearch> => {
  const { database, now } = context
  const folderRow = (id: string) => {
    const row = /^\d+$/.test(id)
      ? database.prepare(`SELECT * FROM accounts WHERE id = ? AND ${filesAccountSql()}`).get(Number(id))
      : undefined
    if (!row) throw new CliError("not_found", `no notes folder ${id} in the local store`)
    return row
  }
  const documentRow = (id: string) => {
    const row = /^\d+$/.test(id) ? database.prepare("SELECT * FROM documents WHERE id = ?").get(Number(id)) : undefined
    if (!row) throw new CliError("not_found", `no file note ${id} in the local store`)
    return row
  }
  const noteRow = (id: string) => {
    const row = /^\d+$/.test(id) ? database.prepare("SELECT * FROM notes WHERE id = ?").get(Number(id)) : undefined
    if (!row) throw new CliError("not_found", `no note ${id} in the local store`)
    return row
  }
  const anyNote = (reference: string) => {
    const found = noteRowOf(database, reference)
    if (!found) throw new CliError("not_found", `no note ${reference} in the local store`)
    return found
  }
  const bounded = (limit = 100, offset = 0) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0)
      throw new CliError("validation_error", "limit takes 1–500 and offset 0 or more")
    return { limit, offset }
  }
  const documentTags = (id: number) => labelsOf(database, { type: "document", id })
  /** A file row of a folder by its path; a local folder's own rows are not notes. */
  const fileAt = (folder: number, path: string, liveOnly = false): Row | undefined =>
    database
      .prepare(
        `SELECT * FROM files WHERE account_id = ? AND external_id = ? AND kind <> 'folder'${liveOnly ? " AND deleted_at IS NULL" : ""}`,
      )
      .get(folder, path)
  const isLocal = (accountId: unknown) =>
    database
      .prepare(`SELECT 1 FROM accounts WHERE id = ? AND provider IN ('local', 'obsidian')`)
      .get(Number(accountId)) !== undefined
  /** Drive's documents are found by its folder and `<id>.md`, whichever account that folder is now. */
  const remoteDocument = (row: Row) => {
    const front = frontMatterObject(row.front_matter)
    return front?.source === "google-drive" || frontMatterObject(row.metadata)?.catalog !== undefined
  }
  /** Drive's own saves keep their documents by folder and `<id>.md`; only files on disk join by content. */
  const localSave = (folder: number, frontMatter: unknown) =>
    isLocal(folder) && (frontMatter as { source?: unknown } | null | undefined)?.source !== "google-drive"
  /**
   * The documents whose shown file has this content: live ones, else gone ones no file holds any more, so a file
   * moved to another folder is the same document whichever folder syncs first. Empty text matches nothing.
   */
  const sameContent = (hash: string | null, text: string): number[] => {
    if (!hash || !text.trim()) return []
    const live = database
      .prepare("SELECT id FROM documents WHERE content_hash = ? AND deleted_at IS NULL ORDER BY id")
      .all(hash)
    if (live.length) return live.map(({ id }) => Number(id))
    return database
      .prepare(
        "SELECT d.id FROM documents d WHERE d.content_hash = ? AND d.deleted_at IS NOT NULL AND NOT EXISTS " +
          "(SELECT 1 FROM files f WHERE f.document_id = d.id AND f.deleted_at IS NULL) ORDER BY d.id",
      )
      .all(hash)
      .map(({ id }) => Number(id))
  }
  /**
   * A local document's own place columns follow the file it shows (the owner's pin, else the latest changed), so
   * readers that still go by `documents.account_id` find it where it is. Drive's documents keep theirs.
   */
  const followPreferred = (id: number, at: number) => {
    const document = documentRow(String(id))
    if (!isLocal(document.account_id) || remoteDocument(document)) return
    const preferred = database
      .prepare(
        `SELECT f.account_id, f.external_id FROM files f JOIN documents d ON d.id = f.document_id
          JOIN accounts a ON a.id = f.account_id WHERE f.document_id = ? AND f.deleted_at IS NULL AND f.kind <> 'folder'
          AND a.provider IN ('local', 'obsidian') ORDER BY ${PREFERRED_FILE} LIMIT 1`,
      )
      .get(id)
    if (!preferred) return
    const [account, path] = [Number(preferred.account_id), String(preferred.external_id)]
    if (Number(document.account_id) === account && String(document.external_id) === path) return
    const blocking = database
      .prepare("SELECT id, deleted_at FROM documents WHERE account_id = ? AND external_id = ? AND id <> ?")
      .get(account, path, id)
    if (blocking?.deleted_at == null && blocking !== undefined) return
    if (blocking) database.prepare("DELETE FROM documents WHERE id = ?").run(Number(blocking.id))
    const { location, fileName, extension } = pathParts(path)
    database
      .prepare(
        "UPDATE documents SET account_id = ?, external_id = ?, location = ?, file_name = ?, extension = ?, updated_at = ? WHERE id = ?",
      )
      .run(account, path, location, fileName, extension, at, id)
  }
  /** The document as the folder that holds this file sees it: its folder and path are the file's. */
  const noteAt = (id: number, folder: number, path: string): Note => ({
    ...documentOf(documentRow(String(id))),
    folderId: String(folder),
    path,
  })

  return {
    addFolder: async ({ name, format = "obsidian" }) => {
      const at = now()
      const checked = oneOf(format, NOTE_FORMATS, "a folder's format")
      const row = database
        .prepare(
          "INSERT INTO accounts (provider, external_id, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .get(
          folderProviderOf(checked),
          ulid(at),
          textOf(name, "a folder's name", 200),
          JSON.stringify({ format: checked }),
          at,
          at,
        )
      return folderOf(folderRow(String(row?.id)))
    },
    folders: async () =>
      database.prepare(`SELECT * FROM accounts WHERE ${folderProviderSql()} ORDER BY name, id`).all().map(folderOf),
    documentsAccount: async ({ provider, account }, create = false) => {
      if (!isDocumentAccountProvider(provider))
        throw new CliError("validation_error", `${provider} is not a provider whose accounts hold documents`)
      const find = () =>
        database.prepare("SELECT * FROM accounts WHERE provider = ? AND external_id = ?").get(provider, account)
      const found = find()
      if (found || !create) return found ? folderOf(found) : undefined
      const at = now()
      database
        .prepare(
          "INSERT OR IGNORE INTO accounts (provider, external_id, name, settings, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)",
        )
        .run(provider, textOf(account, "an account's id", 200), JSON.stringify({ format: "markdown" }), at, at)
      return folderOf(find() as Row)
    },
    documentsAccounts: async () =>
      database
        .prepare(
          `SELECT * FROM accounts WHERE provider IN (${DOCUMENT_ACCOUNT_PROVIDERS.map(() => "?").join(", ")}) ORDER BY provider, external_id`,
        )
        .all(...DOCUMENT_ACCOUNT_PROVIDERS)
        .map(folderOf),
    saveFileNote: async (input) =>
      write(database, () => {
        const folder = Number(folderRow(input.folderId).id)
        const path = textOf(input.path, "a note's path", 4096)
        const text = textOf(input.text, "a note's text", MAX_TEXT_CHARS, true)
        const frontMatter = input.frontMatter == null ? null : JSON.stringify(input.frontMatter)
        let metadata = encodeDocumentMetadata(input.metadata, input.sections)
        const language = languageOf(input.metadata)
        const title =
          typeof input.metadata?.title === "string" && input.metadata.title ? input.metadata.title : input.title
        const at = now()
        const hash = input.contentHash ?? null
        const here = { accountId: folder, path, contentHash: hash, frontMatter: input.frontMatter ?? null }
        const place = fileAt(folder, path)
        const found: Row | undefined =
          place?.document_id != null
            ? documentRow(String(place.document_id))
            : database.prepare("SELECT * FROM documents WHERE account_id = ? AND external_id = ?").get(folder, path)
        // Rule 2 (requirements 3.3): a new local file with the content of exactly one document is a copy of it.
        const candidates = !found && !place && localSave(folder, input.frontMatter) ? sameContent(hash, text) : []
        if (candidates.length === 1) {
          const id = candidates[0] as number
          const joined = documentRow(String(id))
          if (joined.deleted_at != null)
            database
              .prepare("UPDATE documents SET deleted_at = NULL, body = ?, updated_at = ? WHERE id = ?")
              .run(text, at, id)
          syncFile(database, at, id, { place: here, method: "content-hash" })
          followPreferred(id, at)
          return { note: noteAt(id, folder, path), changed: true }
        }
        if (found?.metadata != null) {
          const stored = JSON.parse(String(found.metadata)) as { catalog?: unknown }
          if (stored.catalog !== undefined)
            metadata = JSON.stringify({ ...(metadata == null ? {} : JSON.parse(metadata)), catalog: stored.catalog })
        }
        if (!found) {
          const { location, fileName, extension } = pathParts(path)
          const row = database
            .prepare(
              "INSERT INTO documents (account_id, external_id, kind, title, location, file_name, extension, storage, content_hash, " +
                "front_matter, body, extraction, metadata, language, revision, created_at, updated_at) " +
                "VALUES (?, ?, 'file', ?, ?, ?, ?, 'local', ?, ?, ?, 'text', ?, ?, 1, ?, ?) RETURNING id",
            )
            .get(
              folder,
              path,
              title,
              location,
              fileName,
              extension,
              hash,
              frontMatter,
              text,
              metadata,
              language,
              at,
              at,
            )
          const id = Number(row?.id)
          const file = syncFile(database, at, id)
          if (candidates.length > 1 && file)
            reviewLink(database, { type: "file", id: file.id }, "document", candidates, "content-hash", at)
          return { note: noteAt(id, folder, path), changed: true }
        }
        const id = Number(found.id)
        const own = Number(found.account_id) === folder && String(found.external_id) === path
        // A copy elsewhere changes the document's text; its own front matter stays on its file row.
        const keptFrontMatter = own ? frontMatter : found.front_matter == null ? null : String(found.front_matter)
        const keptMetadata = own ? metadata : found.metadata == null ? null : String(found.metadata)
        const same =
          (found.body ?? "") === text &&
          (found.title ?? null) === title &&
          (found.front_matter ?? null) === keptFrontMatter &&
          (found.metadata ?? null) === keptMetadata &&
          (found.content_hash ?? null) === hash &&
          found.deleted_at == null
        if (!same) {
          if ((found.body ?? "") !== text)
            database
              .prepare("INSERT INTO document_revisions (document_id, body, revision, created_at) VALUES (?, ?, ?, ?)")
              .run(id, String(found.body ?? ""), Number(found.revision), at)
          database
            .prepare(
              "UPDATE documents SET title = ?, body = ?, front_matter = ?, content_hash = ?, metadata = ?, language = ?, " +
                "revision = revision + ?, updated_at = ?, deleted_at = NULL WHERE id = ?",
            )
            .run(
              title,
              text,
              keptFrontMatter,
              hash,
              keptMetadata,
              language,
              (found.body ?? "") === text ? 0 : 1,
              at,
              id,
            )
        }
        syncFile(database, at, id, own ? {} : { place: here })
        if (!same) followPreferred(id, at)
        return { note: noteAt(id, folder, path), changed: !same }
      }),
    renameFileNote: async (folderId, from, to) =>
      write(database, () => {
        const folder = Number(folderRow(folderId).id)
        const target = textOf(to, "a note's path", 4096)
        const at = now()
        const place = fileAt(folder, from, true)
        const legacy = database
          .prepare("SELECT id FROM documents WHERE account_id = ? AND external_id = ? AND deleted_at IS NULL")
          .get(folder, from)
        const id = place?.document_id != null ? Number(place.document_id) : legacy ? Number(legacy.id) : undefined
        if (id === undefined) throw new CliError("not_found", `no live note at ${from} in folder ${folderId}`)
        const takenFile = fileAt(folder, target)
        if (takenFile?.deleted_at == null && takenFile !== undefined)
          throw new CliError("validation_error", `a live note is already at ${target} in folder ${folderId}`)
        const taken = database
          .prepare("SELECT id, deleted_at FROM documents WHERE account_id = ? AND external_id = ? AND id <> ?")
          .get(folder, target, id)
        if (taken && taken.deleted_at == null)
          throw new CliError("validation_error", `a live note is already at ${target} in folder ${folderId}`)
        // The gone note at the target goes, as it always did; its file row goes with it or on its own.
        if (taken) database.prepare("DELETE FROM documents WHERE id = ?").run(Number(taken.id))
        if (takenFile) database.prepare("DELETE FROM files WHERE id = ?").run(Number(takenFile.id))
        if (place) database.prepare("UPDATE files SET external_id = ? WHERE id = ?").run(target, Number(place.id))
        const document = documentRow(String(id))
        const own = Number(document.account_id) === folder && String(document.external_id) === from
        if (own) {
          const { location, fileName, extension } = pathParts(target)
          database
            .prepare(
              "UPDATE documents SET external_id = ?, location = ?, file_name = ?, extension = ?, updated_at = ? WHERE id = ?",
            )
            .run(target, location, fileName, extension, at, id)
          syncFile(database, at, id)
        } else
          syncFile(database, at, id, {
            place: {
              accountId: folder,
              path: target,
              contentHash: place?.content_hash == null ? null : String(place.content_hash),
              frontMatter: frontMatterOf(place?.metadata),
            },
          })
        return noteAt(id, folder, target)
      }),
    deleteFileNotes: async (folderId, paths) =>
      write(database, () => {
        const folder = Number(folderRow(folderId).id)
        let deleted = 0
        for (const path of paths) {
          const at = now()
          const place = fileAt(folder, path, true)
          if (!place) {
            const marked = database
              .prepare(
                "UPDATE documents SET deleted_at = ?, body = '' WHERE account_id = ? AND external_id = ? AND deleted_at IS NULL RETURNING id",
              )
              .all(at, folder, path)
            for (const row of marked) syncFile(database, at, Number(row.id), { seen: false })
            deleted += marked.length
            continue
          }
          database.prepare("UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ?").run(at, at, Number(place.id))
          deleted++
          if (place.document_id == null) continue
          const id = Number(place.document_id)
          // A document stays while any copy of it is live (requirements 3.1.7).
          const elsewhere = database
            .prepare("SELECT 1 FROM files WHERE document_id = ? AND deleted_at IS NULL AND kind <> 'folder' LIMIT 1")
            .get(id)
          if (elsewhere) followPreferred(id, at)
          else
            database
              .prepare("UPDATE documents SET deleted_at = ?, body = '' WHERE id = ? AND deleted_at IS NULL")
              .run(at, id)
        }
        return deleted
      }),
    addNote: async ({ text, title, about = [] }) =>
      write(database, () => {
        const at = now()
        const owner = ownerPerson(database)
        const [subject] = about.map((reference) => requiredThing(database, reference))
        const notable = subject ?? owner
        const row = database
          .prepare(
            "INSERT INTO notes (notable_type, notable_id, title, body, author_type, author_id, revision, created_at, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING id",
          )
          .get(
            notable.type,
            notable.id,
            title === undefined ? null : textOf(title, "a title", 500),
            textOf(text, "a note"),
            owner.type,
            owner.id,
            at,
            at,
          )
        const id = Number(row?.id)
        for (const reference of about.slice(1))
          insertLink(context, { from: `note:${id}`, to: reference, kind: "about", origin: "owner" })
        return noteOf(noteRow(String(id)))
      }),
    note: async (reference) => anyNote(reference),
    resolveNote: async (reference) => {
      const parsed = parseReference(reference)
      return parsed.type === "note" || parsed.type === "document" ? noteRowOf(database, reference) : undefined
    },
    noteReferences: async (reference) => [anyNote(reference).ref],
    notes: async (options = {}) => {
      const { limit, offset } = bounded(options.limit, options.offset)
      if (options.source !== undefined) oneOf(options.source, ["file", "internal"] as const, "a note's source")
      const about = options.about === undefined ? undefined : thingOf(database, canonicalThingReference(options.about))
      if (options.about !== undefined && !about) return { items: [], hasMore: false }
      const folder = options.folderId === undefined ? null : Number(folderRow(options.folderId).id)
      const documentText = options.search === undefined ? undefined : holdingText("document", "d.id", options.search)
      const noteText = options.search === undefined ? undefined : holdingText("note", "n.id", options.search)
      const aboutType = about?.type ?? null
      const aboutId = about?.id ?? null
      const files =
        options.source === "internal"
          ? []
          : database
              .prepare(
                // In a folder, a document is wherever one of its live files is, under that file's path.
                (folder === null
                  ? "SELECT d.* FROM documents d WHERE d.deleted_at IS NULL AND ? IS NULL AND ? IS NULL "
                  : "SELECT d.*, f.account_id AS account_id, CASE WHEN a.provider IN ('local', 'obsidian') " +
                    "THEN f.external_id ELSE d.external_id END AS external_id FROM files f " +
                    "JOIN documents d ON d.id = f.document_id JOIN accounts a ON a.id = f.account_id " +
                    "WHERE f.deleted_at IS NULL AND d.deleted_at IS NULL AND f.account_id = ? AND ? IS NOT NULL ") +
                  "AND coalesce(json_extract(d.metadata, '$.catalog.active'), 1)=1 " +
                  `AND (? IS NULL OR EXISTS (SELECT 1 FROM links l WHERE l.from_type = 'document' AND l.from_id = d.id AND l.kind = ${linkKind("about")} AND l.to_type = ? AND l.to_id = ?)) ` +
                  `${documentText ? `AND ${documentText.sql} ` : ""}ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
              )
              .all(folder, folder, aboutType, aboutType, aboutId, ...(documentText?.params ?? []), limit + offset + 1)
              .map(documentOf)
      const written =
        options.source === "file" || folder !== null
          ? []
          : database
              .prepare(
                "SELECT n.* FROM notes n WHERE n.deleted_at IS NULL " +
                  `AND (? IS NULL OR (n.notable_type = ? AND n.notable_id = ?) OR EXISTS (SELECT 1 FROM links l WHERE l.from_type = 'note' AND l.from_id = n.id AND l.kind = ${linkKind("about")} AND l.to_type = ? AND l.to_id = ?)) ` +
                  `${noteText ? `AND ${noteText.sql} ` : ""}ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
              )
              .all(aboutType, aboutType, aboutId, aboutType, aboutId, ...(noteText?.params ?? []), limit + offset + 1)
              .map(noteOf)
      const all = [...files, ...written].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.ref.localeCompare(a.ref),
      )
      return { items: all.slice(offset, offset + limit), hasMore: all.length > offset + limit }
    },
    importedDocuments: async (folderId, query, { limit, offset }) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0)
        throw new CliError("validation_error", "limit takes 1–1000 and offset 0 or more")
      const folder = Number(folderRow(folderId).id)
      const where = query ? importedDocumentWhere(database, query) : undefined
      const rows = database
        .prepare(
          "SELECT d.* FROM documents d WHERE d.account_id = ? AND d.body IS NOT NULL AND d.deleted_at IS NULL " +
            "AND coalesce(json_extract(d.metadata, '$.catalog.active'), 1) = 1 " +
            `AND (${where?.sql || "1"}) ORDER BY d.created_at, d.id LIMIT ? OFFSET ?`,
        )
        .all(folder, ...(where?.params ?? []), limit + 1, offset)
      return { items: rows.slice(0, limit).map(documentOf), hasMore: rows.length > limit }
    },
    editNote: async (id, text, revision) =>
      write(database, () => {
        if (id.startsWith("document:"))
          throw new CliError("validation_error", "a file note is edited in its file; the next import reads it")
        const bare = id.replace(/^note:/, "")
        const found = noteRow(bare)
        const changed = database
          .prepare(
            "UPDATE notes SET body = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL",
          )
          .run(textOf(text, "a note"), now(), Number(bare), revision).changes
        if (!changed)
          throw new CliError("validation_error", "the note changed; read its current revision before editing")
        database
          .prepare("INSERT INTO note_revisions (note_id, body, revision, created_at) VALUES (?, ?, ?, ?)")
          .run(Number(bare), String(found.body), revision, now())
        return noteOf(noteRow(bare))
      }),
    removeNote: async (id) =>
      write(database, () => {
        if (id.startsWith("document:"))
          throw new CliError("validation_error", "a file note goes when its file does; the next import notices")
        const bare = id.replace(/^note:/, "")
        noteRow(bare)
        database.prepare("DELETE FROM notes WHERE id = ?").run(Number(bare))
        return { id, removed: true as const }
      }),
    addLink: async (input) => write(database, () => insertLink(context, input)),
    links: async (options = {}) => {
      const pair = (reference: string | undefined) => {
        if (reference === undefined) return { known: true, type: null, id: null }
        const thing = thingOf(database, canonicalThingReference(reference))
        return thing ? { known: true, type: thing.type, id: thing.id } : { known: false, type: null, id: null }
      }
      const from = pair(options.from)
      const to = pair(options.to)
      if (!from.known || !to.known) return []
      const filters = [
        ...(options.id === undefined ? [] : [{ sql: "CAST(id AS TEXT) = ?", value: options.id }]),
        ...(options.kind === undefined ? [] : [{ sql: "kind = ?", value: options.kind }]),
        ...(options.role === undefined ? [] : [{ sql: "role = ?", value: options.role }]),
        ...(options.origin === undefined ? [] : [{ sql: "source = ?", value: options.origin }]),
        ...(options.confirmed === undefined ? [] : [{ sql: "confirmed = ?", value: options.confirmed ? 1 : 0 }]),
      ]
      return database
        .prepare(
          "SELECT * FROM links WHERE (? IS NULL OR (from_type = ? AND from_id = ?)) AND (? IS NULL OR (to_type = ? AND to_id = ?)) " +
            `AND (? = 0 OR to_id IS NULL)${filters.map(({ sql }) => ` AND (${sql})`).join("")} ORDER BY created_at, id LIMIT 5000`,
        )
        .all(
          from.type,
          from.type,
          from.id,
          to.type,
          to.type,
          to.id,
          options.unresolved ? 1 : 0,
          ...filters.map(({ value }) => value),
        )
        .map((row) => linkOf(database, row))
    },
    removeLink: async (id) =>
      write(database, () => {
        if (!/^\d+$/.test(id) || !database.prepare("DELETE FROM links WHERE id = ?").run(Number(id)).changes)
          throw new CliError("not_found", `no link ${id} in the local store`)
        return { id, removed: true as const }
      }),
    replaceFileLinks: async (documentId, links) =>
      write(database, () => {
        const id = Number(documentRow(documentId).id)
        database.prepare("DELETE FROM links WHERE from_type = 'document' AND from_id = ? AND source = 'file'").run(id)
        return links.map((link) => insertLink(context, { ...link, from: `document:${id}`, origin: "file" }))
      }),
    linkMessages: async ({ documents, since }) => {
      const after = since === undefined ? null : Date.parse(since)
      if (after !== null && Number.isNaN(after))
        throw new CliError("validation_error", `since takes an ISO 8601 time, not "${since}"`)
      return write(database, () => {
        // Older writers capture text revisions without advancing messages.updated_at.
        const candidates = database.prepare(
          "SELECT m.id, m.text FROM messages_fts f JOIN messages m ON m.id = f.rowid " +
            "WHERE messages_fts MATCH ? AND m.deleted_at IS NULL AND (? IS NULL OR m.created_at >= ? " +
            "OR EXISTS (SELECT 1 FROM message_revisions r WHERE r.message_id = m.id AND r.created_at >= ?))",
        )
        const existing = database.prepare(
          "SELECT 1 FROM links WHERE from_type = 'message' AND from_id = ? AND to_type = 'document' AND to_id = ? " +
            `AND kind = ${linkKind("links-to")}`,
        )
        const insert = database.prepare(
          "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, author, created_at, updated_at) " +
            `VALUES ('message', ?, 'document', ?, ${linkKind("links-to")}, 'message', 1, 'rule', ?, ?)`,
        )
        const at = now()
        let added = 0
        for (const { reference, fileId } of documents) {
          const document = requiredThing(database, reference, "the document")
          if (document.type !== "document")
            throw new CliError("validation_error", `${reference} is not a document; give document:<id>`)
          // The trigram index needs three characters, and no Google file id is that short.
          if (fileId.length < 3) continue
          for (const row of candidates.all(`"${fileId.replaceAll('"', '""')}"`, after, after, after)) {
            const id = Number(row.id)
            if (!googleDocumentLinks(String(row.text)).some((link) => link.documentId === fileId)) continue
            if (existing.get(id, document.id)) continue
            insert.run(id, document.id, at, at)
            added += 1
          }
        }
        return added
      })
    },
    replaceFileTags: async (documentId, tags) =>
      write(database, () => {
        const id = Number(documentRow(documentId).id)
        const stated = [...new Set(tags.map(normalizeTag))]
        const selected = [...new Set(stated.map((name) => ensureTag(context, name).id))]
        database
          .prepare(
            "DELETE FROM taggings WHERE taggable_type = 'document' AND taggable_id = ? AND source = 'file' " +
              "AND tag_id NOT IN (SELECT t.id FROM resolved_tags t JOIN json_each(?) j ON j.value=t.canonical_id)",
          )
          .run(id, JSON.stringify(selected))
        addTags(context, { type: "document", id }, stated, "file")
        return documentTags(id)
      }),
    noteTags: async (reference) => {
      const note = anyNote(reference)
      return labelsOf(database, { type: note.source === "file" ? "document" : "note", id: Number(note.id) })
    },
    resolveLinks: async () =>
      write(database, () =>
        database
          .prepare("SELECT DISTINCT target_folded FROM links WHERE to_id IS NULL AND target_folded IS NOT NULL")
          .all()
          .reduce((sum, row) => sum + resolveKey(database, String(row.target_folded)), 0),
      ),
  }
}
