import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { MAX_TEXT_CHARS } from "../../attachments/limits.js"
import { ADDED_ACCOUNT, ADDED_PROVIDER, notAdded } from "../../domain/providers.js"
import type { Section } from "../../readers/types.js"
import type { Decider } from "../decisions.js"
import { fold } from "../normalize.js"
import { type DocumentMetadata, encodeDocumentMetadata, languageOf } from "./document-metadata.js"
import { syncFile } from "./files.js"
import { linkKind } from "./link-kinds.js"
import {
  documentOf,
  folderOf,
  insertLink,
  keepRevision,
  type Note,
  type NoteFolder,
  pathParts,
  requiredThing,
  thingRef,
} from "./notes.js"
import type { StoreContext } from "./open.js"
import { oneOf, textOf } from "./text-input.js"
import { write } from "./transaction.js"

export const ADDED_KINDS = ["text", "file", "page"] as const

/** A source the owner adds by hand: pasted text, a file, or a page read from a link. */
export interface AddedSourceInput {
  kind: (typeof ADDED_KINDS)[number]
  /** What a reader found; empty when it found none (`read: "no-text"`). */
  text: string
  read: "extracted" | "no-text"
  title?: string | null
  /** The page's address, or where a file came from. */
  url?: string | null
  fileName?: string | null
  mime?: string | null
  size?: number | null
  /** A file's own bytes, which name it. Pasted text and a page are named by their normalized text. */
  bytes?: Uint8Array
  /** People, organizations, projects, tasks or meetings it is about (`person:3`), linked `about`. */
  subjects?: readonly string[]
  /** The owner's subjects are his statement; an agent's wait unconfirmed, as its links always do. */
  by: Decider
  /** Where the caller keeps a copy of the file. Without it only the text is kept, and nothing claims a copy. */
  keepCopy?: { path: string }
  metadata?: DocumentMetadata
  sections?: Section[]
  /**
   * What names it where it came from, `<namespace>:<id>` (`google-drive:<fileId>`). A source saved again under the
   * same key is that source: changed text becomes its next revision, so what cites it is reviewed, never a second
   * copy. Without a key a source is named by its content.
   */
  sourceKey?: string
}

/** What names an added source: enough to find it before anything is written. */
export type AddedSourceContent = Pick<AddedSourceInput, "kind" | "text" | "url" | "bytes" | "sourceKey">

/** The part of `store.notes` that keeps the sources added by hand. */
export interface AddedSources {
  /**
   * Saves a source the owner added by hand into the `added` account, named `sha256:<hash>`: a repeat is the same
   * document, and a live folder or Drive document with the same content is answered as `duplicateOf`, given only the
   * new subjects.
   */
  saveAddedSource(input: AddedSourceInput): Promise<AddedSource>
  /** The account of the sources added by hand, once one was saved. */
  addedAccount(): Promise<NoteFolder | undefined>
  /** A live source added by hand, with what was kept of it; `undefined` for any other document or reference. */
  addedSource(reference: string): Promise<AddedSourceDetails | undefined>
  /**
   * What saving this content would find, read only: the live added source it repeats, or the folder or Drive document
   * it duplicates. A caller that keeps a copy of the file asks this first, and writes the copy only when both are null.
   */
  findAddedSource(content: AddedSourceContent): Promise<{ existing: string | null; duplicateOf: string | null }>
  /**
   * Removes an added source the way a folder file's removal does: its text goes, its row stays as deleted. The owner's
   * alone. Answers the copy's path, for the caller to delete, when one was kept.
   */
  removeAddedSource(reference: string, by: Decider): Promise<{ ref: string; removed: true; copy: string | null }>
}

export interface AddedSource {
  /** The document holding it: the added one, or the live document of the same content it duplicates. */
  note: Note
  created: boolean
  /** The folder or Drive document with the same content, when nothing new was stored. */
  duplicateOf: string | null
  /** What is kept of the source: its text, or its text and a copy; `null` for a duplicate. */
  kept: "text" | "copy" | null
  /** Whether its text was written now: a new source, a revived one, or a new revision under its source key. */
  changed: boolean
  /** Every subject the document is about now, the ones linked before included. */
  subjects: string[]
}

/** What a source added by hand is, beyond the document every reader shows. */
export interface AddedSourceDetails {
  note: Note
  kind: (typeof ADDED_KINDS)[number]
  /** The page's address as given, or where a file came from. */
  url: string | null
  fileName: string | null
  mime: string | null
  /** Bytes of the file or the page as read. */
  size: number | null
  kept: "text" | "copy"
  /** Where the caller keeps the copy, when one was kept. */
  copy: string | null
}

type Row = Record<string, unknown>

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")

// `sha256:` is the content's own name, so no key may take it.
const SOURCE_KEY = /^(?!sha256:)[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._~-]{1,200}$/

const sourceKeyOf = (key: string) => {
  if (!SOURCE_KEY.test(key))
    throw new CliError(
      "validation_error",
      "a source key is <namespace>:<id>: a lower-case namespace other than sha256, then letters, digits, . _ ~ or -",
      { param: "sourceKey" },
    )
  return key
}

/**
 * The key an added source is stored under: its source key, else `sha256:<hash>` (a file's bytes; pasted text or a page
 * by its normalized text, or its address when it has none), and every hash a folder or Drive document of the same
 * content may carry.
 */
export const addedSourceKeyOf = (
  content: AddedSourceContent,
): { externalId: string; hash: string; hashes: string[] } => {
  const kind = oneOf(content.kind, ADDED_KINDS, "an added source's kind")
  if (kind === "file" && !content.bytes) throw new CliError("validation_error", "an added file needs its bytes")
  const text = content.text.trim()
  const url = content.url?.trim() || null
  const normalized = text.normalize("NFC").replace(/\s+/gu, " ").trim()
  if (kind !== "file" && !normalized && !url)
    throw new CliError("validation_error", "an added source without text needs its address")
  const hash = kind === "file" ? sha256(content.bytes as Uint8Array) : sha256(normalized || (url as string))
  // Drive keeps the sha256 of the text it exported, as is: pasted text or a page with that text is that file.
  const hashes = [...new Set(kind === "file" || !text ? [hash] : [hash, sha256(content.text)])]
  const externalId = content.sourceKey === undefined ? `sha256:${hash}` : sourceKeyOf(content.sourceKey)
  return { externalId, hash, hashes }
}

/** The input checked. */
const checked = (input: AddedSourceInput) => {
  const read = oneOf(input.read, ["extracted", "no-text"] as const, "what was read")
  const text = textOf(input.text, "an added source's text", MAX_TEXT_CHARS, read === "no-text")
  if (read === "no-text" && text) throw new CliError("validation_error", "a source read as no-text has no text")
  if (input.kind === "text" && read === "no-text") throw new CliError("validation_error", "pasted text cannot be empty")
  const url = input.url == null ? null : textOf(input.url, "an added source's address", 4096)
  if (input.kind === "page" && !url) throw new CliError("validation_error", "an added page needs its address")
  const copy = input.keepCopy === undefined ? null : textOf(input.keepCopy.path, "the copy's path", 4096)
  if (copy !== null && input.kind !== "file") throw new CliError("validation_error", "only a file is kept as a copy")
  const fileName = input.fileName == null ? null : textOf(input.fileName, "a file's name", 500)
  const title = input.title == null || !input.title.trim() ? null : textOf(input.title, "a title", 500)
  return {
    ...addedSourceKeyOf(input),
    kind: input.kind,
    read,
    text,
    url,
    copy,
    title,
    fileName,
    extension: fileName === null ? null : pathParts(fileName).extension,
  }
}

export const addedSourcesOver = (context: StoreContext): AddedSources => {
  const { database, now } = context
  const accountRow = (): Row | undefined =>
    database.prepare("SELECT * FROM accounts WHERE provider = ? AND external_id = ?").get(ADDED_PROVIDER, ADDED_ACCOUNT)
  const documentAt = (id: number) => documentOf(database.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row)
  const ownRow = (externalId: string): Row | undefined => {
    const account = accountRow()
    return account
      ? database
          .prepare("SELECT * FROM documents WHERE account_id = ? AND external_id = ?")
          .get(Number(account.id), externalId)
      : undefined
  }
  const about = (id: number, subjects: readonly string[], by: Decider): string[] => {
    const at = now()
    for (const subject of subjects) {
      if (by === "owner") {
        const link = insertLink(context, { from: `document:${id}`, to: subject, kind: "about", origin: "owner" })
        // An agent's proposal of the same subject is what the owner now states.
        if (!link.confirmed)
          database
            .prepare("UPDATE links SET confirmed = 1, source = 'owner', author = 'owner', updated_at = ? WHERE id = ?")
            .run(at, Number(link.id))
        continue
      }
      const thing = requiredThing(database, subject, "a subject")
      const known = database
        .prepare(
          `SELECT 1 FROM links WHERE from_type = 'document' AND from_id = ? AND to_type = ? AND to_id = ? AND kind = ${linkKind("about")} AND anchor IS NULL`,
        )
        .get(id, thing.type, thing.id)
      const link = insertLink(context, {
        from: `document:${id}`,
        to: subject,
        kind: "about",
        origin: "suggested",
        confirmed: false,
        provenance: by.reason,
      })
      if (!known)
        database
          .prepare("UPDATE links SET author = ?, metadata = ? WHERE id = ?")
          .run(
            by.bot,
            JSON.stringify({ provenance: by.reason, ...(by.model ? { model: by.model } : {}) }),
            Number(link.id),
          )
    }
    return database
      .prepare(
        `SELECT to_type, to_id FROM links WHERE from_type = 'document' AND from_id = ? AND kind = ${linkKind("about")} ` +
          "AND to_id IS NOT NULL ORDER BY id",
      )
      .all(id)
      .flatMap((row) => thingRef(database, row.to_type, row.to_id) ?? [])
  }
  /** A live folder or Drive document with this content; a document no reader could read matches nothing. */
  const duplicateOf = (hashes: string[]): number | undefined => {
    const row = database
      .prepare(
        "SELECT d.id FROM documents d WHERE d.content_hash IN (SELECT value FROM json_each(?)) AND d.deleted_at IS NULL " +
          `AND d.body <> '' AND ${notAdded} AND coalesce(json_extract(d.metadata, '$.catalog.active'), 1) = 1 ` +
          "ORDER BY d.id LIMIT 1",
      )
      .get(JSON.stringify(hashes))
    return row ? Number(row.id) : undefined
  }
  /** Its `files` row is named as the owner named the source, not by its hash. */
  const placeFile = (id: number, at: number, name: string) => {
    syncFile(database, at, id)
    database
      .prepare("UPDATE files SET name = ?, path = ?, path_folded = ? WHERE document_id = ? AND kind <> 'folder'")
      .run(name, name, fold(name), id)
  }

  return {
    addedAccount: async () => {
      const row = accountRow()
      return row ? folderOf(row) : undefined
    },
    addedSource: async (reference) => {
      const id = /^document:[1-9]\d*$/.test(reference) ? Number(reference.slice("document:".length)) : undefined
      const row =
        id === undefined
          ? undefined
          : database
              .prepare(
                "SELECT d.* FROM documents d JOIN accounts a ON a.id = d.account_id WHERE d.id = ? AND a.provider = ? " +
                  "AND d.deleted_at IS NULL",
              )
              .get(id, ADDED_PROVIDER)
      if (!row) return undefined
      const copy = row.storage === "copy" && row.local_path != null ? String(row.local_path) : null
      return {
        note: documentOf(row),
        kind: oneOf(String(row.kind), ADDED_KINDS, "an added source's kind"),
        url: row.url == null ? null : String(row.url),
        fileName: row.file_name == null ? null : String(row.file_name),
        mime: row.mime == null ? null : String(row.mime),
        size: row.size == null ? null : Number(row.size),
        kept: copy === null ? "text" : "copy",
        copy,
      }
    },
    findAddedSource: async (content) => {
      const key = addedSourceKeyOf(content)
      const own = ownRow(key.externalId)
      if (own && own.deleted_at == null) return { existing: `document:${own.id}`, duplicateOf: null }
      const duplicate = duplicateOf(key.hashes)
      return { existing: null, duplicateOf: duplicate === undefined ? null : `document:${duplicate}` }
    },
    removeAddedSource: async (reference, by) => {
      if (by !== "owner")
        throw new CliError("permission_error", "only the owner removes a source he added", {
          reason: "proposal.owner-only",
        })
      return write(database, () => {
        const id = /^document:\d+$/.test(reference) ? Number(reference.slice("document:".length)) : Number.NaN
        const row = database
          .prepare(
            "SELECT d.* FROM documents d JOIN accounts a ON a.id = d.account_id WHERE d.id = ? AND a.provider = ? " +
              "AND d.deleted_at IS NULL",
          )
          .get(id, ADDED_PROVIDER)
        if (!row) throw new CliError("not_found", `no live added source ${reference} in the local store`)
        const at = now()
        database
          .prepare("UPDATE files SET deleted_at = ?, updated_at = ? WHERE document_id = ? AND deleted_at IS NULL")
          .run(at, at, id)
        database.prepare("UPDATE documents SET deleted_at = ?, body = '' WHERE id = ?").run(at, id)
        return {
          ref: `document:${id}`,
          removed: true as const,
          copy: row.storage === "copy" ? String(row.local_path) : null,
        }
      })
    },
    saveAddedSource: async (input) => {
      const source = checked(input)
      const metadata = encodeDocumentMetadata(input.metadata, input.sections)
      const subjects = input.subjects ?? []
      return write(database, () => {
        const at = now()
        const own = ownRow(source.externalId)
        if (own !== undefined && own.deleted_at == null) {
          const id = Number(own.id)
          const revised = input.sourceKey !== undefined && own.content_hash !== source.hash
          if (revised) {
            keepRevision(database, own, at)
            database
              .prepare(
                "UPDATE documents SET kind = ?, title = ?, file_name = ?, extension = ?, url = ?, mime = ?, size = ?, " +
                  "content_hash = ?, body = ?, extraction = ?, metadata = ?, language = ?, revision = revision + 1, " +
                  "updated_at = ? WHERE id = ?",
              )
              .run(
                source.kind,
                source.title,
                source.fileName,
                source.extension,
                source.url,
                input.mime ?? null,
                input.size ?? input.bytes?.byteLength ?? null,
                source.hash,
                source.text,
                source.read === "extracted" ? "text" : "none",
                metadata,
                languageOf(input.metadata),
                at,
                id,
              )
            placeFile(id, at, source.fileName ?? source.title ?? source.externalId)
          }
          if (source.copy !== null && own.storage !== "copy")
            database
              .prepare("UPDATE documents SET storage = 'copy', local_path = ?, updated_at = ? WHERE id = ?")
              .run(source.copy, at, id)
          const kept = source.copy !== null || own.storage === "copy" ? "copy" : "text"
          return {
            note: documentAt(id),
            created: false,
            duplicateOf: null,
            kept,
            changed: revised,
            subjects: about(id, subjects, input.by),
          }
        }
        const duplicate = duplicateOf(source.hashes)
        if (duplicate !== undefined) {
          const linked = about(duplicate, subjects, input.by)
          const note = documentAt(duplicate)
          return { note, created: false, duplicateOf: note.ref, kept: null, changed: false, subjects: linked }
        }
        const values = [
          source.kind,
          source.title,
          source.fileName,
          source.extension,
          source.url,
          source.copy === null ? "text" : "copy",
          source.copy,
          input.mime ?? null,
          input.size ?? input.bytes?.byteLength ?? null,
          source.hash,
          source.text,
          source.read === "extracted" ? "text" : "none",
          metadata,
          languageOf(input.metadata),
        ]
        let id: number
        if (own) {
          id = Number(own.id)
          database
            .prepare(
              "UPDATE documents SET kind = ?, title = ?, file_name = ?, extension = ?, url = ?, storage = ?, local_path = ?, " +
                "mime = ?, size = ?, content_hash = ?, body = ?, extraction = ?, metadata = ?, language = ?, " +
                "updated_at = ?, deleted_at = NULL WHERE id = ?",
            )
            .run(...values, at, id)
        } else {
          const holder =
            accountRow()?.id ??
            database
              .prepare(
                "INSERT INTO accounts (provider, external_id, name, settings, created_at, updated_at) " +
                  "VALUES (?, ?, NULL, ?, ?, ?) RETURNING id",
              )
              .get(ADDED_PROVIDER, ADDED_ACCOUNT, JSON.stringify({ format: "markdown" }), at, at)?.id
          id = Number(
            database
              .prepare(
                "INSERT INTO documents (account_id, external_id, kind, title, file_name, extension, url, storage, local_path, " +
                  "mime, size, content_hash, body, extraction, metadata, language, revision, created_at, updated_at) " +
                  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING id",
              )
              .get(Number(holder), source.externalId, ...values, at, at)?.id,
          )
        }
        placeFile(id, at, source.fileName ?? source.title ?? source.externalId)
        return {
          note: documentAt(id),
          created: !own,
          duplicateOf: null,
          kept: source.copy === null ? "text" : "copy",
          changed: true,
          subjects: about(id, subjects, input.by),
        }
      })
    },
  }
}
