import type { CacheDatabase } from "../driver.js"
import { fold, normalize } from "../normalize.js"
import type { AccountKey } from "../types.js"
import { accountPk, findAccountPk } from "./accounts.js"
import type { CopyViewer } from "./copy-viewer.js"
import type { StoreContext } from "./open.js"
import { pageOfRows } from "./rows-page.js"
import { write } from "./transaction.js"

/** A downloaded file of a CRM record as the store keeps it: never a download link. */
export interface CrmFileRow {
  /** `<owner kind>:<owner id>:<source kind>:<provider id>`. */
  externalId: string
  ownerKind: string
  ownerId: string
  /** The identity `<account>/user/<id>` the owner record was assigned to at download, as a deal's assignee is kept. */
  ownerAssignee: string | null
  source: string
  name: string
  mime: string | null
  size: number | null
  externalCreatedAt: number | null
  /** Null once the disk cap dropped the file; its text stays. */
  localPath: string | null
  contentSha256: string | null
  text: string | null
  /** The `Extraction` status reading the text ended with. */
  extraction: string | null
  extractionError: string | null
  /** The CRM user id of the sign-in that downloaded it. */
  downloadedBy: string | null
  downloadedAt: number
}

export interface CrmFileHit {
  account: AccountKey
  file: Omit<CrmFileRow, "text">
  /** Some text around the first word found. */
  excerpt: string
}

export interface CrmFileSearch {
  words: string[]
  anyWord?: boolean
  /** Whole words only, no word they begin. */
  exact?: boolean
  /** Absent: every CRM account's. */
  accounts?: AccountKey[]
  /** Each limits its own account's rows to the files of records assigned to its user (NEED-2707 A). */
  viewers?: CopyViewer[]
  limit?: number
}

export interface CrmFileStore {
  /** One downloaded file, replacing an earlier download of the same id. */
  save(key: AccountKey, file: CrmFileRow): Promise<void>
  get(key: AccountKey, externalId: string): Promise<CrmFileRow | undefined>
  /** The downloaded files of one record, without their text. */
  ofOwner(key: AccountKey, kind: string, id: string): Promise<Omit<CrmFileRow, "text">[]>
  /** The bytes of the files saved under `folder`; a copy saved elsewhere is the owner's and not counted. */
  storedBytes(key: AccountKey, folder: string): Promise<number>
  /** Files under `folder` whose text is stored, oldest download first: what the disk cap may drop. */
  droppable(key: AccountKey, folder: string): Promise<Omit<CrmFileRow, "text">[]>
  /** The saved file is gone; the row and its text stay, so search still finds it. */
  forgetFile(key: AccountKey, externalId: string): Promise<void>
  find(search: CrmFileSearch): Promise<{ items: CrmFileHit[]; hasMore: boolean }>
}

const MOST = 500
const EXCERPT = 240

const COLUMNS =
  "f.external_id, f.owner_kind, f.owner_id, f.owner_assignee, f.source, f.name, f.mime, f.size, " +
  "f.external_created_at, f.local_path, f.content_sha256, f.extraction, f.extraction_error, f.downloaded_by, " +
  "f.downloaded_at"

const text = (value: unknown) => (value === null || value === undefined ? null : String(value))
const number = (value: unknown) => (value === null || value === undefined ? null : Number(value))

const rowOf = (row: Record<string, unknown>): Omit<CrmFileRow, "text"> => ({
  externalId: String(row.external_id),
  ownerKind: String(row.owner_kind),
  ownerId: String(row.owner_id),
  ownerAssignee: text(row.owner_assignee),
  source: String(row.source),
  name: String(row.name),
  mime: text(row.mime),
  size: number(row.size),
  externalCreatedAt: number(row.external_created_at),
  localPath: text(row.local_path),
  contentSha256: text(row.content_sha256),
  extraction: text(row.extraction),
  extractionError: text(row.extraction_error),
  downloadedBy: text(row.downloaded_by),
  downloadedAt: Number(row.downloaded_at),
})

/** One FTS5 phrase per word, quoted so no word is read as syntax; a word may start a longer one unless `exact`. */
const matchOf = (words: readonly string[], anyWord: boolean, exact: boolean): string | undefined => {
  const phrases = words
    .map((word) => normalize(word).trim())
    .filter(Boolean)
    .map((word) => {
      const quoted = `"${word.replaceAll('"', '""')}"`
      return exact || /\s/u.test(word) || word.length < 3 ? quoted : `${quoted}*`
    })
  return phrases.length ? [...new Set(phrases)].join(anyWord ? " OR " : " AND ") : undefined
}

const excerptOf = (body: string, words: readonly string[]): string => {
  const folded = fold(body)
  const at = words
    .map((word) => folded.indexOf(fold(word).trim()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0]
  const start = Math.max(0, (at ?? 0) - EXCERPT / 4)
  return body
    .slice(start, start + EXCERPT)
    .replace(/\s+/gu, " ")
    .trim()
}

/** `store rebuild`: the normalized copies follow the current normalizer, then the word index is filled again. */
export const resetCrmFileWords = (database: CacheDatabase): number => {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'crm_file_words'").get()) return 0
  return write(database, () => {
    const update = database.prepare("UPDATE crm_files SET normalized_text = ? WHERE id = ?")
    for (const row of database
      .prepare("SELECT id, text, normalized_text FROM crm_files WHERE text IS NOT NULL")
      .all()) {
      const normalized = normalize(String(row.text))
      if (normalized !== row.normalized_text) update.run(normalized, Number(row.id))
    }
    database.exec("INSERT INTO crm_file_words (crm_file_words) VALUES ('delete-all')")
    const { changes } = database
      .prepare(
        "INSERT INTO crm_file_words (rowid, normalized_text) SELECT id, normalized_text FROM crm_files " +
          "WHERE normalized_text <> ''",
      )
      .run()
    return Number(changes)
  })
}

export const crmFilesOver = (context: StoreContext): CrmFileStore => {
  const { database } = context
  const under = "substr(f.local_path, 1, length(?)) = ?"

  const save = (key: AccountKey, file: CrmFileRow) =>
    write(database, () => {
      const accountId = accountPk(context, key)
      database
        .prepare(
          "INSERT INTO crm_files (account_id, external_id, owner_kind, owner_id, owner_assignee, source, name, " +
            "name_folded, mime, size, external_created_at, local_path, content_sha256, text, normalized_text, " +
            "extraction, extraction_error, downloaded_by, downloaded_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (account_id, external_id) DO UPDATE SET owner_assignee = excluded.owner_assignee, " +
            "source = excluded.source, name = excluded.name, name_folded = excluded.name_folded, " +
            "mime = excluded.mime, size = excluded.size, external_created_at = excluded.external_created_at, " +
            "local_path = excluded.local_path, content_sha256 = excluded.content_sha256, text = excluded.text, " +
            "normalized_text = excluded.normalized_text, extraction = excluded.extraction, " +
            "extraction_error = excluded.extraction_error, downloaded_by = excluded.downloaded_by, " +
            "downloaded_at = excluded.downloaded_at",
        )
        .run(
          accountId,
          file.externalId,
          file.ownerKind,
          file.ownerId,
          file.ownerAssignee,
          file.source,
          file.name,
          fold(file.name),
          file.mime,
          file.size,
          file.externalCreatedAt,
          file.localPath,
          file.contentSha256,
          file.text,
          file.text === null ? null : normalize(file.text),
          file.extraction,
          file.extractionError,
          file.downloadedBy,
          file.downloadedAt,
        )
    })

  const rowsOf = (key: AccountKey, where: string, ...params: (string | number)[]) => {
    const accountId = findAccountPk(context, key)
    if (accountId === undefined) return []
    return database
      .prepare(`SELECT ${COLUMNS}, f.text FROM crm_files f WHERE f.account_id = ? AND ${where}`)
      .all(accountId, ...params)
  }

  const find = ({ words, anyWord = false, exact = false, accounts, viewers = [], limit }: CrmFileSearch) => {
    const match = matchOf(words, anyWord, exact)
    if (!match) return { items: [], hasMore: false }
    const most = Math.min(Math.max(limit ?? 100, 1), MOST)
    const scoped = accounts?.map((one) => findAccountPk(context, one)).filter((one) => one !== undefined) ?? []
    if (accounts !== undefined && !scoped.length) return { items: [], hasMore: false }
    // A viewer limits only its own account; another account's rows pass it, as `seenBy` lets them.
    const limits = viewers.flatMap((viewer) => {
      const id = findAccountPk(context, viewer.account)
      return id === undefined ? [] : [{ id, assignee: viewer.assignee }]
    })
    const params: (string | number)[] = [match]
    let sql =
      `SELECT ${COLUMNS}, f.text, a.provider, a.external_id AS account FROM crm_files f ` +
      "JOIN accounts a ON a.id = f.account_id " +
      "JOIN (SELECT rowid, rank FROM crm_file_words WHERE crm_file_words MATCH ?) w ON w.rowid = f.id WHERE 1"
    if (accounts !== undefined) {
      sql += ` AND f.account_id IN (${scoped.map(() => "?").join(", ")})`
      for (const id of scoped) params.push(id)
    }
    for (const one of limits) {
      sql += one.assignee === null ? " AND f.account_id <> ?" : " AND (f.account_id <> ? OR f.owner_assignee = ?)"
      params.push(one.id)
      if (one.assignee !== null) params.push(one.assignee)
    }
    sql += " ORDER BY w.rank, f.downloaded_at DESC, f.id DESC LIMIT ?"
    params.push(most + 1)
    const hits = database
      .prepare(sql)
      .all(...params)
      .map(
        (row): CrmFileHit => ({
          account: { provider: String(row.provider), account: String(row.account) },
          file: rowOf(row),
          excerpt: excerptOf(String(row.text ?? ""), words),
        }),
      )
    return pageOfRows(hits, most)
  }

  return {
    save: async (key, file) => save(key, file),
    get: async (key, externalId) => {
      const [row] = rowsOf(key, "f.external_id = ?", externalId)
      return row ? { ...rowOf(row), text: text(row.text) } : undefined
    },
    ofOwner: async (key, kind, id) =>
      rowsOf(key, "f.owner_kind = ? AND f.owner_id = ? ORDER BY f.downloaded_at DESC, f.id DESC", kind, id).map(rowOf),
    storedBytes: async (key, folder) =>
      rowsOf(key, `f.local_path IS NOT NULL AND ${under}`, folder, folder).reduce(
        (sum, row) => sum + Number(row.size ?? 0),
        0,
      ),
    droppable: async (key, folder) =>
      rowsOf(
        key,
        `f.local_path IS NOT NULL AND ${under} AND coalesce(f.text, '') <> '' ORDER BY f.downloaded_at, f.id`,
        folder,
        folder,
      ).map(rowOf),
    forgetFile: async (key, externalId) => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined) return
      write(database, () =>
        database
          .prepare("UPDATE crm_files SET local_path = NULL WHERE account_id = ? AND external_id = ?")
          .run(accountId, externalId),
      )
    },
    find: async (search) => find(search),
  }
}
