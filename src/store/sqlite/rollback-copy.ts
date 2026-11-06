import { mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs"
import { basename, dirname, join, parse } from "node:path"
import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"

/**
 * A breaking migration (one that raises `min_compatible`) locks older tools out of the store. Before it runs, the
 * base tables it names are copied into a small file in `backups/` beside the store, with the whole schema as it was;
 * `store restore <copy>` puts them back and returns the file to the old version. Derived tables are never copied:
 * search indexes, their queues, vectors, chunks, mentions and involvements are rebuilt from the base tables.
 */
const DERIVED =
  /(_fts|_words|_stems|_trigrams|_pending)$|^(embeddings|chunks|chunk_messages|mentions|involvements|search_terms)$|^vector_index/

export const isDerivedTable = (name: string): boolean => DERIVED.test(name)

export interface RollbackCopyOptions {
  /** The store's own path: the copy goes in `backups/` beside it. */
  store: string
  freeBytes?: (dir: string) => number
  warn?: (line: string) => void
}

export interface RollbackCopy {
  path: string
  from: number
  to: number
}

/**
 * Always copied, a few rows each: migrations seed rows into them, and the next upgrade after a rollback would insert
 * those rows again and fail on its own unique keys.
 */
const BOOKKEEPING = ["store_settings", "search_index_state"]
const KEY = "rollback_copy:"
const SCHEMA = "rollback_copy"
const ROWID = "__rollback_rowid"
const DAY_MS = 24 * 60 * 60 * 1000
// The migration's own write-ahead log needs room too.
const HEADROOM = 256 * 1024 * 1024

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const megabytes = (bytes: number) => `${Math.ceil(bytes / 1024 / 1024)} MB`

const freeBytesOf = (dir: string): number => {
  const { bavail, bsize } = statfsSync(dir)
  return Number(bavail) * Number(bsize)
}

const tableIn = (database: CacheDatabase, schema: string, name: string): boolean =>
  database.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined

const keepsRowid = (database: CacheDatabase, schema: string, table: string): boolean =>
  Number(database.prepare("SELECT wr FROM pragma_table_list WHERE schema = ? AND name = ?").get(schema, table)?.wr) ===
  0

const columnsOf = (database: CacheDatabase, schema: string, table: string): string[] =>
  database
    .prepare("SELECT name FROM pragma_table_info(?, ?)")
    .all(table, schema)
    .map((row) => String(row.name))

const versionOf = (database: CacheDatabase): number =>
  Number(database.prepare("SELECT max(version) AS version FROM main.schema_migrations").get()?.version ?? 0)

const tableBytes = (database: CacheDatabase, tables: string[]): number => {
  try {
    return Number(
      database
        .prepare(
          `SELECT coalesce(sum(pgsize), 0) AS bytes FROM dbstat
           WHERE schema = 'main' AND aggregate = 1 AND name IN (${tables.map(() => "?").join(", ")})`,
        )
        .get(...tables)?.bytes ?? 0,
    )
  } catch {
    // Bun's SQLite is built without dbstat: the whole file is the bound.
    const pragma = (name: string) => Number(database.prepare(`PRAGMA ${name}`).get()?.[name] ?? 0)
    return pragma("page_count") * pragma("page_size")
  }
}

const stampOf = (at: number) => new Date(at).toISOString().replace(/[:.]/g, "-")

const attach = (database: CacheDatabase, path: string) => database.prepare(`ATTACH DATABASE ? AS ${SCHEMA}`).run(path)

/**
 * Outside the migration's transaction (SQLite cannot attach inside one), committed on its own, so a migration that
 * fails leaves it whole. Never blocks the migration: no room, or any failure, is a warning and no copy.
 */
export const takeRollbackCopy = (
  database: CacheDatabase,
  { from, to, tables, at }: { from: number; to: number; tables: string[]; at: number },
  { store, freeBytes = freeBytesOf, warn = (line) => process.stderr.write(`${line}\n`) }: RollbackCopyOptions,
): RollbackCopy | undefined => {
  const dir = join(dirname(store), "backups")
  const present = [...new Set([...BOOKKEEPING, ...tables])].filter((table) => tableIn(database, "main", table))
  const afterwards = `going back to schema ${from} then needs an empty store, and its data pulled again from the sources`
  let path: string | undefined
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const needed = tableBytes(database, present)
    const free = freeBytes(dir)
    if (free < needed + HEADROOM) {
      warn(
        `not enough free disk space for a rollback copy before schema ${to} (about ${megabytes(needed + HEADROOM)} ` +
          `needed, ${megabytes(free)} free in ${dir}) — migrating without one; ${afterwards}`,
      )
      return undefined
    }
    path = join(dir, `${parse(store).name}-rollback-schema-${from}-${stampOf(at)}.db`)
    writeFileSync(path, "", { flag: "wx", mode: 0o600 })
    attach(database, path)
    try {
      database.exec("BEGIN IMMEDIATE")
      try {
        const copied = versionOf(database)
        database.exec(`CREATE TABLE ${SCHEMA}.rollback_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
        database.exec(
          `CREATE TABLE ${SCHEMA}.rollback_schema AS
           SELECT m.type, m.name, m.tbl_name, m.sql, coalesce(l.type, m.type) AS kind
           FROM main.sqlite_master m LEFT JOIN pragma_table_list l ON l.schema = 'main' AND l.name = m.name
           ORDER BY m.rowid`,
        )
        for (const table of present) {
          const rowid = keepsRowid(database, "main", table) ? `rowid AS ${ROWID}, ` : ""
          database.exec(`CREATE TABLE ${SCHEMA}.${quote(table)} AS SELECT ${rowid}* FROM main.${quote(table)}`)
        }
        const meta = { from: copied, to, tables: present, created_at: at }
        const insert = database.prepare(`INSERT INTO ${SCHEMA}.rollback_meta (key, value) VALUES (?, ?)`)
        for (const [key, value] of Object.entries(meta)) insert.run(key, JSON.stringify(value))
        database.exec("COMMIT")
        return { path, from: copied, to }
      } catch (error) {
        database.exec("ROLLBACK")
        throw error
      }
    } finally {
      database.exec(`DETACH DATABASE ${SCHEMA}`)
    }
  } catch (error) {
    if (path) rmSync(path, { force: true })
    warn(
      `the rollback copy before schema ${to} could not be written (${error instanceof Error ? error.message : String(error)}) — migrating without one; ${afterwards}`,
    )
    return undefined
  }
}

/** Inside the migration's transaction: a migration that fails never records its copy, so cleanup never takes it. */
export const recordRollbackCopy = (database: CacheDatabase, copy: RollbackCopy, at: number): void => {
  database
    .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
    .run(`${KEY}${basename(copy.path)}`, JSON.stringify({ path: copy.path, from: copy.from, to: copy.to, at }), at)
}

export const discardRollbackCopy = (copy: RollbackCopy): void => rmSync(copy.path, { force: true })

/**
 * The day after: a copy recorded by a migration that committed, once the store is still at that version. Only the
 * recorded file is deleted, never anything else in `backups/`.
 */
export const pruneRollbackCopies = (database: CacheDatabase, now: number): void => {
  const recorded = database
    .prepare("SELECT key, value FROM store_settings WHERE key LIKE 'rollback\\_copy:%' ESCAPE '\\'")
    .all()
  if (recorded.length === 0) return
  const version = versionOf(database)
  for (const { key, value } of recorded) {
    let copy: { path?: unknown; to?: unknown; at?: unknown }
    try {
      copy = JSON.parse(String(value)) as typeof copy
    } catch {
      continue
    }
    if (typeof copy.path !== "string" || now - Number(copy.at) < DAY_MS || version < Number(copy.to)) continue
    if (!database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(Number(copy.to))) continue
    rmSync(copy.path, { force: true })
    database.prepare("DELETE FROM store_settings WHERE key = ?").run(String(key))
  }
}

interface SavedObject {
  type: string
  name: string
  sql: string | null
  kind: string
}

const objectsOf = (database: CacheDatabase, sql: string): SavedObject[] =>
  database
    .prepare(sql)
    .all()
    .map((row) => ({
      type: String(row.type),
      name: String(row.name),
      sql: row.sql === null ? null : String(row.sql),
      kind: String(row.kind),
    }))

const currentObjects = (database: CacheDatabase): SavedObject[] =>
  objectsOf(
    database,
    `SELECT m.type, m.name, m.sql, coalesce(l.type, m.type) AS kind
     FROM main.sqlite_master m LEFT JOIN pragma_table_list l ON l.schema = 'main' AND l.name = m.name`,
  )

const internal = ({ name, kind }: SavedObject) => name.startsWith("sqlite_") || kind === "shadow"

export interface RollbackCopyMeta {
  from: number
  to: number
  tables: string[]
  createdAt: number
}

const metaOf = (database: CacheDatabase): RollbackCopyMeta => {
  const values = new Map(
    database
      .prepare(`SELECT key, value FROM ${SCHEMA}.rollback_meta`)
      .all()
      .map((row) => [String(row.key), JSON.parse(String(row.value)) as unknown]),
  )
  const tables = values.get("tables")
  return {
    from: Number(values.get("from")),
    to: Number(values.get("to")),
    tables: Array.isArray(tables) ? tables.map(String) : [],
    createdAt: Number(values.get("created_at")),
  }
}

/** FTS5 tables over a table's own rows; the other search indexes hold their own text and wait for `store rebuild`. */
const contentOf = (sql: string | null): string | undefined => /\bcontent\s*=\s*'([^']+)'/i.exec(sql ?? "")?.[1]

const RANK: Record<string, number> = { table: 0, index: 1, view: 2, trigger: 3 }

/**
 * Returns the file to the schema the copy saved: every object made since is dropped, every table the migration
 * changed is put back with its rows, a table only extended since is rebuilt to its old shape, and the history
 * goes back to the copy's version. One transaction: on any failure the store is as it was.
 */
const rewind = (database: CacheDatabase, saved: SavedObject[], named: Set<string>): string[] => {
  const before = new Map(saved.map((object) => [object.name, object]))
  const same = (object: SavedObject) =>
    before.get(object.name)?.type === object.type && before.get(object.name)?.sql === object.sql
  const touched = new Set(named)
  const rebuilt: string[] = []
  // A trigger or view over a table dropped or rebuilt below would point nowhere; all of them come back from the copy.
  for (const object of currentObjects(database)) {
    if (object.type === "trigger") database.exec(`DROP TRIGGER IF EXISTS ${quote(object.name)}`)
    if (object.type === "view") database.exec(`DROP VIEW IF EXISTS ${quote(object.name)}`)
    if (object.type === "index" && object.sql !== null && !same(object))
      database.exec(`DROP INDEX IF EXISTS ${quote(object.name)}`)
  }
  for (const object of currentObjects(database)) {
    if (object.type !== "table" || internal(object)) continue
    const old = before.get(object.name)
    if (named.has(object.name) || !old || (object.kind === "virtual" && !same(object))) {
      database.exec(`DROP TABLE ${quote(object.name)}`)
    } else if (!same(object) && old.sql) {
      rebuild(database, object.name, old.sql)
      rebuilt.push(object.name)
      touched.add(object.name)
    }
  }
  const present = new Set(currentObjects(database).map(({ name }) => name))
  const missing = saved
    .filter((object) => !internal(object) && object.sql !== null && !present.has(object.name))
    .sort((a, b) => (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9))
  for (const object of missing) {
    database.exec(object.sql as string)
    if (object.type === "table" && named.has(object.name)) restoreRows(database, object.name)
    if (object.kind === "virtual") touched.add(object.name)
  }
  for (const object of saved) {
    const content = contentOf(object.sql)
    if (object.kind !== "virtual" || !(content && (touched.has(content) || touched.has(object.name)))) continue
    database.exec(`INSERT INTO ${quote(object.name)} (${quote(object.name)}) VALUES ('rebuild')`)
  }
  return rebuilt
}

const rebuild = (database: CacheDatabase, table: string, sql: string) => {
  const aside = `__rollback_${table}`
  database.exec(`ALTER TABLE ${quote(table)} RENAME TO ${quote(aside)}`)
  database.exec(sql)
  const kept = new Set(columnsOf(database, "main", aside))
  const columns = columnsOf(database, "main", table).filter((column) => kept.has(column))
  const rowid = keepsRowid(database, "main", table) ? ["rowid"] : []
  const list = [...rowid, ...columns.map(quote)].join(", ")
  database.exec(`INSERT INTO ${quote(table)} (${list}) SELECT ${list} FROM ${quote(aside)}`)
  database.exec(`DROP TABLE ${quote(aside)}`)
}

const restoreRows = (database: CacheDatabase, table: string) => {
  const copied = new Set(columnsOf(database, SCHEMA, table))
  const columns = columnsOf(database, "main", table).filter((column) => copied.has(column))
  const rowid = keepsRowid(database, "main", table) && copied.has(ROWID)
  const into = [...(rowid ? ["rowid"] : []), ...columns.map(quote)].join(", ")
  const from = [...(rowid ? [ROWID] : []), ...columns.map(quote)].join(", ")
  database.exec(`INSERT INTO main.${quote(table)} (${into}) SELECT ${from} FROM ${SCHEMA}.${quote(table)}`)
}

export interface RollbackResult extends RollbackCopyMeta {
  /** The schema the store was at before the rollback. */
  was: number
  restored: { table: string; rows: number }[]
  rebuilt: string[]
  foreignKeyViolations: number
}

/** Puts a rollback copy back into the store, in place. The caller makes sure nothing else has the store open. */
export const rollBack = (database: CacheDatabase, path: string): RollbackResult => {
  attach(database, path)
  let result: Omit<RollbackResult, "foreignKeyViolations">
  try {
    if (!tableIn(database, SCHEMA, "rollback_meta"))
      throw new CliError("validation_error", `${path} is not a rollback copy`)
    const meta = metaOf(database)
    const was = versionOf(database)
    if (!database.prepare("SELECT 1 FROM main.schema_migrations WHERE version = ?").get(meta.to)) {
      throw new CliError(
        "validation_error",
        `the store is at schema ${was} and was never migrated to ${meta.to}, the schema this copy was taken before — nothing to roll back`,
      )
    }
    const saved = objectsOf(database, `SELECT type, name, sql, kind FROM ${SCHEMA}.rollback_schema ORDER BY rowid`)
    database.exec("PRAGMA foreign_keys = OFF")
    // Renaming a table aside must not rewrite the references other tables hold to it.
    database.exec("PRAGMA legacy_alter_table = ON")
    try {
      database.exec("BEGIN IMMEDIATE")
      try {
        const named = new Set(meta.tables)
        const rebuilt = rewind(database, saved, named)
        database.prepare("DELETE FROM main.schema_migrations WHERE version > ?").run(meta.from)
        database.prepare("DELETE FROM main.store_settings WHERE key = ?").run(`${KEY}${basename(path)}`)
        database.exec("COMMIT")
        const count = (table: string) =>
          Number(database.prepare(`SELECT count(*) AS n FROM main.${quote(table)}`).get()?.n ?? 0)
        result = {
          ...meta,
          was,
          restored: meta.tables.map((table) => ({ table, rows: count(table) })),
          rebuilt,
        }
      } catch (error) {
        database.exec("ROLLBACK")
        throw error
      }
    } finally {
      database.exec("PRAGMA legacy_alter_table = OFF")
      database.exec("PRAGMA foreign_keys = ON")
    }
  } finally {
    database.exec(`DETACH DATABASE ${SCHEMA}`)
  }
  // Only the tables put back: a check of the whole store reads every row of it.
  const checked = [...result.restored.map(({ table }) => table), ...result.rebuilt]
  const foreignKeyViolations = checked.reduce(
    (total, table) => total + database.prepare(`PRAGMA foreign_key_check(${quote(table)})`).all().length,
    0,
  )
  return { ...result, foreignKeyViolations }
}
