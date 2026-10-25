import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import type { TABLE_KINDS } from "../../entities/store-table.js"
import type { CacheDatabase } from "../driver.js"
import { openSqlite } from "./open.js"

export type TableKind = (typeof TABLE_KINDS)[number]

export interface StoreTable {
  name: string
  kind: TableKind
  /** Counted for data and internal tables only: a search index's row count is a scan of the whole index. */
  rows: number | null
  /** With sizes: the pages the table and its indexes hold; null for a search index, whose parts hold its pages. */
  bytes?: number | null
}

export interface TableFilter {
  name?: string
  kind?: TableKind
}

const BOOKKEEPING = ["schema_migrations", "store_settings"]

/** `PRAGMA table_list` names virtual and shadow tables itself, so a new search index needs no list kept here. */
const LISTED = `
  SELECT name, CASE
      WHEN type = 'virtual' THEN 'search_index'
      WHEN type = 'shadow' THEN 'search_index_part'
      WHEN name LIKE 'sqlite\\_%' ESCAPE '\\' OR name IN (${BOOKKEEPING.map((name) => `'${name}'`).join(", ")})
        THEN 'internal'
      ELSE 'data'
    END AS kind
  FROM pragma_table_list
  WHERE schema = 'main' AND name <> 'sqlite_schema'`

/** Read-only by the connection itself: listing tables must not set a journal mode or migrate the file. */
export const readStoreTables = async (path: string, options: { filter?: TableFilter; sizes?: boolean } = {}) => {
  const { database } = await openSqlite(path, { readOnly: true })
  try {
    return storeTables(database, options)
  } finally {
    database.close()
  }
}

export const storeTables = (
  database: CacheDatabase,
  { filter = {}, sizes = false }: { filter?: TableFilter; sizes?: boolean } = {},
): StoreTable[] => {
  const listed = database
    .prepare(
      `SELECT name, kind FROM (${LISTED})
       WHERE (? IS NULL OR name = ?) AND (? IS NULL OR kind = ?) ORDER BY name`,
    )
    .all(filter.name ?? null, filter.name ?? null, filter.kind ?? null, filter.kind ?? null)
    .map((row) => ({ name: String(row.name), kind: String(row.kind) as TableKind }))
  const bytes = sizes ? pageBytes(database) : undefined
  return listed.map(({ name, kind }) => ({
    name,
    kind,
    rows: kind === "data" || kind === "internal" ? rowCount(database, name) : null,
    ...(bytes ? { bytes: kind === "search_index" ? null : (bytes.get(name) ?? 0) } : {}),
  }))
}

const rowCount = (database: CacheDatabase, table: string): number =>
  Number(database.prepare(`SELECT count(*) AS n FROM "${table.replaceAll('"', '""')}"`).get()?.n ?? 0)

/** Every page of the file is read: about ten seconds for a 3 GB store whose pages are not in memory. */
const pageBytes = (database: CacheDatabase): Map<string, number> => {
  let rows: Record<string, unknown>[]
  try {
    // Joined here, not in SQL: as the inner side of a join, dbstat walks the whole file once per outer row.
    rows = database.prepare("SELECT name, pgsize FROM dbstat WHERE schema = 'main' AND aggregate = 1").all()
  } catch (error) {
    if (!/no such table: dbstat/.test(String(error))) throw error
    throw new CliError(
      "configuration_error",
      "this SQLite cannot measure table sizes (it was built without dbstat) — run the command under Node instead of Bun",
    )
  }
  const owners = new Map(
    database
      .prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index'")
      .all()
      .map((row) => [String(row.name), String(row.tbl_name)]),
  )
  const bytes = new Map<string, number>()
  for (const { name, pgsize } of rows) {
    const owner = owners.get(String(name)) ?? String(name)
    bytes.set(owner, (bytes.get(owner) ?? 0) + Number(pgsize))
  }
  return bytes
}

/** Facts about the file itself, cheap enough for `store info`: no page is read beyond the header and the history. */
export const fileFacts = (database: CacheDatabase, path: string) => {
  const pragma = (name: string) => database.prepare(`PRAGMA ${name}`).get()?.[name]
  const tracked = database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'schema_migrations'").get()
  return {
    journalMode: String(pragma("journal_mode")),
    pages: {
      size: Number(pragma("page_size")),
      count: Number(pragma("page_count")),
      free: Number(pragma("freelist_count")),
    },
    migrations: tracked
      ? database
          .prepare("SELECT version, min_compatible, applied_at FROM schema_migrations ORDER BY version")
          .all()
          .map((row) => ({
            version: Number(row.version),
            minCompatible: Number(row.min_compatible),
            appliedAt: new Date(Number(row.applied_at)).toISOString(),
          }))
      : [],
    backup: lastBackup(path),
  }
}

/**
 * The marker the owner's backup job writes beside the store; cli-memo's `mail trash` already trusts it. Only its
 * time, file name and check are passed on, and a marker that does not parse reads as none.
 */
const lastBackup = (path: string): { at: string; file: string | null; checked: string | null } | null => {
  const marker = join(dirname(path), "backups", "last.json")
  if (!existsSync(marker)) return null
  try {
    const { at, file, checked } = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>
    const time = typeof at === "string" ? Date.parse(at) : Number.NaN
    if (Number.isNaN(time)) return null
    return {
      at: new Date(time).toISOString(),
      file: typeof file === "string" ? file : null,
      checked: typeof checked === "string" ? checked : null,
    }
  } catch {
    return null
  }
}
