import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"
import type { StoreContext } from "./open.js"
import { thingOf } from "./things.js"
import { write } from "./transaction.js"

type Row = Record<string, unknown>

/** Why a sync took a document out of its copy. Only `deleted` is a deletion the source reported. */
export const DOCUMENT_REMOVALS = ["deleted", "unavailable", "unsynced"] as const
export type DocumentRemoval = (typeof DOCUMENT_REMOVALS)[number]

/** What replaced a kept version: an edit, or one of the removals. */
export type VersionReason = "edited" | DocumentRemoval

export const DOCUMENT_EVENTS = ["added", "changed", "restored", ...DOCUMENT_REMOVALS] as const
export type DocumentEvent = (typeof DOCUMENT_EVENTS)[number]

/** One earlier version of a document, as the store kept it before something replaced it. */
export interface DocumentVersion {
  revision: number
  title: string | null
  reason: VersionReason
  /** When this version was replaced or removed; the current version's is when it was written. */
  replacedAt: string | null
  current: boolean
  characters: number
}

export interface DocumentVersionText extends DocumentVersion {
  text: string
  frontMatter: unknown
}

export interface DocumentHistoryAnswer {
  ref: string
  title: string | null
  path: string
  revision: number
  deletedAt: string | null
  removal: DocumentRemoval | null
  /** Newest first, the current version at the top. */
  versions: DocumentVersion[]
}

export interface DocumentChange {
  ref: string
  path: string
  title: string | null
  event: DocumentEvent
  revision: number
  at: string
}

export interface DocumentHistoryStore {
  /** The document at this path of a documents account, a removed one too, as `document:<n>`. */
  documentAt(folderId: string, path: string): Promise<string | undefined>
  documentHistory(reference: string): Promise<DocumentHistoryAnswer>
  documentVersion(reference: string, revision: number): Promise<DocumentVersionText>
  /** What changed in the account at or after `since` (ISO 8601), newest first. */
  documentChanges(
    folderId: string,
    options: { since: string; until?: string; events?: readonly DocumentEvent[]; limit: number; offset: number },
  ): Promise<{ items: DocumentChange[]; hasMore: boolean }>
  /**
   * Drops the versions and the change log of the account older than `before` (ISO 8601), and the text of a document
   * that has been unavailable since before then. Answers what it dropped.
   */
  pruneDocumentHistory(folderId: string, before: string): Promise<{ versions: number; changes: number; texts: number }>
}

const iso = (value: unknown) => (value == null ? null : new Date(Number(value)).toISOString())
const json = (value: unknown) => (value == null ? null : (JSON.parse(String(value)) as unknown))

/**
 * Keeps a document's text, title and front matter under its current revision before the caller replaces or removes
 * them with `revision + 1`, so a citation reads back the words it cited and the history shows what was there.
 */
export const keepRevision = (database: CacheDatabase, row: Row, at: number, reason: VersionReason = "edited") =>
  database
    .prepare(
      "INSERT INTO document_revisions (document_id, body, revision, created_at, title, front_matter, reason) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      Number(row.id),
      String(row.body ?? ""),
      Number(row.revision),
      at,
      row.title == null ? null : String(row.title),
      row.front_matter == null ? null : String(row.front_matter),
      reason,
    )

/** One line of the change log, from the document row as it is after the change. */
export const logDocumentChange = (database: CacheDatabase, id: number, event: DocumentEvent, at: number) => {
  const row = database.prepare("SELECT account_id, external_id, title, revision FROM documents WHERE id = ?").get(id)
  if (!row) return
  database
    .prepare(
      "INSERT INTO document_changes (account_id, document_id, path, title, event, revision, at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      Number(row.account_id),
      id,
      String(row.external_id),
      row.title == null ? null : String(row.title),
      event,
      Number(row.revision),
      at,
    )
}

/**
 * Takes a document out of the live copy for `reason`. An unavailable one keeps its text, since the source may show it
 * again; a deleted or unsynced one keeps its last text as a version and its body is blanked.
 */
export const removeDocument = (database: CacheDatabase, id: number, at: number, reason: DocumentRemoval) => {
  const row = database.prepare("SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL").get(id)
  if (!row) return false
  if (reason === "unavailable")
    database.prepare("UPDATE documents SET deleted_at = ?, removal = ? WHERE id = ?").run(at, reason, id)
  else {
    if (row.body != null) keepRevision(database, row, at, reason)
    database
      .prepare("UPDATE documents SET deleted_at = ?, removal = ?, body = '', revision = revision + 1 WHERE id = ?")
      .run(at, reason, id)
  }
  logDocumentChange(database, id, reason, at)
  return true
}

const removalOf = (value: unknown): DocumentRemoval | null =>
  DOCUMENT_REMOVALS.includes(value as DocumentRemoval) ? (value as DocumentRemoval) : null

export const documentHistoryOver = ({ database }: StoreContext): DocumentHistoryStore => {
  const account = (folderId: string) => {
    const row = /^\d+$/.test(folderId)
      ? database.prepare("SELECT id FROM accounts WHERE id = ?").get(Number(folderId))
      : undefined
    if (!row) throw new CliError("not_found", `no documents account ${folderId} in the local store`)
    return Number(row.id)
  }
  const documentRow = (reference: string): Row => {
    const thing = thingOf(database, reference)
    const row =
      thing?.type === "document" ? database.prepare("SELECT * FROM documents WHERE id = ?").get(thing.id) : undefined
    if (!row) throw new CliError("not_found", `document ${reference} is not in the local store`)
    return row
  }
  const kept = (id: number) =>
    database
      .prepare(
        "SELECT revision, title, front_matter, reason, body, created_at FROM document_revisions " +
          "WHERE document_id = ? ORDER BY revision DESC, id DESC",
      )
      .all(id)
  const keptVersion = (row: Row, current = false): DocumentVersion => ({
    revision: Number(row.revision),
    title: row.title == null ? null : String(row.title),
    reason: current ? "edited" : ((row.reason ?? "edited") as VersionReason),
    replacedAt: current ? null : iso(row.created_at),
    current,
    characters: String(row.body ?? "").length,
  })
  // A removed document's row holds no text of its own once its last version was kept: it is not a version then.
  const currentShown = (row: Row) => row.deleted_at == null || String(row.body ?? "") !== ""
  return {
    documentAt: async (folderId, path) => {
      const row = database
        .prepare("SELECT id FROM documents WHERE account_id = ? AND external_id = ?")
        .get(account(folderId), path)
      return row ? `document:${row.id}` : undefined
    },
    documentHistory: async (reference) => {
      const row = documentRow(reference)
      const id = Number(row.id)
      return {
        ref: `document:${id}`,
        title: row.title == null ? null : String(row.title),
        path: String(row.external_id),
        revision: Number(row.revision),
        deletedAt: iso(row.deleted_at),
        removal: row.deleted_at == null ? null : removalOf(row.removal),
        versions: [
          ...(currentShown(row) ? [{ ...keptVersion(row, true), replacedAt: iso(row.updated_at) }] : []),
          ...kept(id).map((one) => keptVersion(one)),
        ],
      }
    },
    documentVersion: async (reference, revision) => {
      const row = documentRow(reference)
      if (Number(row.revision) === revision && currentShown(row))
        return {
          ...keptVersion(row, true),
          replacedAt: iso(row.updated_at),
          text: String(row.body ?? ""),
          frontMatter: json(row.front_matter),
        }
      const found = kept(Number(row.id)).find((one) => Number(one.revision) === revision)
      if (!found)
        throw new CliError("not_found", `document ${reference} has no version ${revision} in the local store`, {
          reason: "document.version-missing",
        })
      return { ...keptVersion(found), text: String(found.body ?? ""), frontMatter: json(found.front_matter) }
    },
    documentChanges: async (folderId, { since, until, events, limit, offset }) => {
      const from = Date.parse(since)
      const to = until === undefined ? Number.MAX_SAFE_INTEGER : Date.parse(until)
      if (Number.isNaN(from) || Number.isNaN(to))
        throw new CliError("validation_error", "since and until take an ISO 8601 time")
      const kinds = events?.length ? events : DOCUMENT_EVENTS
      const rows = database
        .prepare(
          "SELECT * FROM document_changes WHERE account_id = ? AND at >= ? AND at <= ? " +
            `AND event IN (${kinds.map(() => "?").join(", ")}) ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(account(folderId), from, to, ...kinds, limit + 1, offset)
      return {
        items: rows.slice(0, limit).map((row) => ({
          ref: `document:${row.document_id}`,
          path: String(row.path),
          title: row.title == null ? null : String(row.title),
          event: row.event as DocumentEvent,
          revision: Number(row.revision),
          at: iso(row.at) as string,
        })),
        hasMore: rows.length > limit,
      }
    },
    pruneDocumentHistory: async (folderId, before) =>
      write(database, () => {
        const id = account(folderId)
        const cut = Date.parse(before)
        if (Number.isNaN(cut)) throw new CliError("validation_error", "before takes an ISO 8601 time")
        const versions = database
          .prepare(
            "DELETE FROM document_revisions WHERE created_at < ? " +
              "AND document_id IN (SELECT id FROM documents WHERE account_id = ?)",
          )
          .run(cut, id).changes
        const changes = database
          .prepare("DELETE FROM document_changes WHERE account_id = ? AND at < ?")
          .run(id, cut).changes
        const texts = database
          .prepare(
            "UPDATE documents SET body = '', revision = revision + 1 WHERE account_id = ? AND removal = 'unavailable' " +
              "AND deleted_at IS NOT NULL AND deleted_at < ? AND body <> ''",
          )
          .run(id, cut).changes
        return { versions, changes, texts }
      }),
  }
}
