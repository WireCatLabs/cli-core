import { existsSync, statSync } from "node:fs"
import type { CacheDatabase } from "./driver.js"
import { openSqlite } from "./sqlite/open.js"

/** One table's share of what `PRAGMA quick_check` found; `table` is null for pages no table claims. */
export interface DamagedTable {
  table: string | null
  problems: number
  /** The first line SQLite gave for it: page and cell numbers, never row content. */
  sample: string
}

export interface SearchIndexHealth {
  name: string
  ok: boolean
  error?: string
}

export interface StoreHealth {
  path: string
  /** `quick`: the file header and the schema only, in milliseconds. `deep`: every page and every search index. */
  checked: "quick" | "deep"
  ok: boolean
  error?: string
  file?: { bytes: number; pages: number; pageSize: number; freePages: number }
  damagedTables?: DamagedTable[]
  /** Lines `quick_check` gave in all, capped at `QUICK_CHECK_LIMIT`. */
  problems?: number
  searchIndexes?: SearchIndexHealth[]
  ms: number
}

export const QUICK_CHECK_LIMIT = 10_000

/** What `doctor` checks by default, said where it answers. */
export const QUICK_HEALTH_CHECKS = "the file header, its size against its page count, and the schema's own pages"

const FTS5 = /^\s*CREATE\s+VIRTUAL\s+TABLE\s+\S+\s+USING\s+fts5\s*\(/i

export const fts5Tables = (database: CacheDatabase): { name: string; sql: string; external: boolean }[] =>
  database
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name",
    )
    .all()
    .filter((row) => FTS5.test(String(row.sql)))
    .map((row) => {
      const sql = String(row.sql)
      return { name: String(row.name), sql, external: /content\s*=\s*'[^']+'/i.test(sql) }
    })

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const bytesOf = (path: string) => statSync(path, { throwIfNoEntry: false })?.size ?? 0

/** Groups the lines by the table whose tree they name: `Tree <root page> …` or `NULL value in <table>.<column>`. */
export const damagedTables = (database: CacheDatabase, lines: string[]): DamagedTable[] => {
  const roots = new Map(
    database
      .prepare("SELECT rootpage, tbl_name FROM sqlite_master WHERE rootpage > 0")
      .all()
      .map((row) => [Number(row.rootpage), String(row.tbl_name)]),
  )
  const owners = new Map(
    database
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => [String(row.name), String(row.tbl_name)]),
  )
  const virtual = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'")
    .all()
    .map((row) => String(row.name))
  // A search index's rows live in its shadow tables: `email_words_data` is damage to `email_words`.
  const ownerOf = (table: string | null) =>
    table === null ? null : (virtual.find((name) => table.startsWith(`${name}_`)) ?? table)
  const tables = new Map<string | null, DamagedTable>()
  for (const raw of lines) {
    const line = raw.replace(/^\*\*\* in database \w+ \*\*\*\s*/, "")
    const tree = /^Tree (\d+) /.exec(line)
    const column = /value in (\w+)\.\w+/.exec(line) ?? /^table (\w+): /.exec(line)
    const index = /index (\w+)/.exec(line)?.[1]
    const table = ownerOf(
      tree
        ? (roots.get(Number(tree[1])) ?? null)
        : column
          ? (column[1] ?? null)
          : index
            ? (owners.get(index) ?? null)
            : null,
    )
    const known = tables.get(table)
    if (known) known.problems += 1
    else tables.set(table, { table, problems: 1, sample: line.slice(0, 200) })
  }
  return [...tables.values()].sort((a, b) => b.problems - a.problems)
}

/** `rank = 0` checks the index's own structure, the only check a contentless index has; it writes nothing. */
export const searchIndexHealth = (database: CacheDatabase): SearchIndexHealth[] =>
  fts5Tables(database).map(({ name }) => {
    try {
      database.exec("BEGIN")
      try {
        database.exec(`INSERT INTO "${name}" ("${name}", rank) VALUES ('integrity-check', 0)`)
      } finally {
        database.exec("ROLLBACK")
      }
      return { name, ok: true }
    } catch (error) {
      return { name, ok: false, error: messageOf(error) }
    }
  })

const pragmaLines = (database: CacheDatabase, sql: string) =>
  database
    .prepare(sql)
    .all()
    .flatMap((row) => String(Object.values(row)[0]).split("\n"))

/**
 * SQLite stops the whole check at a page it cannot read and returns none of what it found. Then each table is
 * checked alone, so the answer still names every damaged one.
 */
const checkLines = (database: CacheDatabase): string[] => {
  try {
    return pragmaLines(database, `PRAGMA quick_check(${QUICK_CHECK_LIMIT})`)
  } catch {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND rootpage > 0 ORDER BY name")
      .all()
      .map((row) => String(row.name))
    return tables.flatMap((table) => {
      try {
        return pragmaLines(database, `PRAGMA quick_check("${table}")`).filter((line) => line !== "ok")
      } catch (error) {
        return [`table ${table}: ${messageOf(error)}`]
      }
    })
  }
}

const quickHealth = (database: CacheDatabase, path: string) => {
  const pragma = (name: string) => Number(Object.values(database.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0)
  const file = {
    bytes: bytesOf(path),
    pages: pragma("page_count"),
    pageSize: pragma("page_size"),
    freePages: pragma("freelist_count"),
  }
  const schema = database
    .prepare("PRAGMA quick_check('sqlite_schema')")
    .all()
    .map((row) => String(Object.values(row)[0]))
  // Pages still in the write-ahead log are not in the file yet, so only a file with none of them must match.
  const walFrames = existsSync(`${path}-wal`) && bytesOf(`${path}-wal`) > 0
  const sized = walFrames || file.bytes === file.pages * file.pageSize
  const problems = [
    ...(schema.length === 1 && schema[0] === "ok" ? [] : schema),
    ...(sized ? [] : [`the file holds ${file.bytes} bytes, its header says ${file.pages * file.pageSize}`]),
  ]
  return { file, problems }
}

/**
 * The store's health without changing it. `quick` takes milliseconds at any size; `deep` reads every page
 * (about 30 s for 6 GB) and checks every search index, under a transaction it rolls back.
 */
export const storeHealth = async (path: string, { deep = false }: { deep?: boolean } = {}): Promise<StoreHealth> => {
  const started = Date.now()
  const checked = deep ? "deep" : "quick"
  const done = (health: Omit<StoreHealth, "path" | "checked" | "ms">): StoreHealth => ({
    path,
    checked,
    ...health,
    ms: Date.now() - started,
  })
  let database: CacheDatabase
  try {
    database = (await openSqlite(path, { readOnly: !deep })).database
  } catch (error) {
    return done({ ok: false, error: messageOf(error) })
  }
  try {
    const { file, problems } = quickHealth(database, path)
    if (!deep) {
      return done({
        ok: problems.length === 0,
        file,
        ...(problems.length
          ? {
              problems: problems.length,
              damagedTables: [{ table: null, problems: problems.length, sample: problems[0] as string }],
            }
          : {}),
      })
    }
    database.exec("PRAGMA busy_timeout = 30000")
    const lines = checkLines(database)
    const pagesOk = lines.length === 1 && lines[0] === "ok"
    const indexes = searchIndexHealth(database)
    return done({
      ok: pagesOk && problems.length === 0 && indexes.every((index) => index.ok),
      file,
      problems: pagesOk ? 0 : lines.length,
      damagedTables: pagesOk ? [] : damagedTables(database, lines),
      searchIndexes: indexes,
    })
  } catch (error) {
    return done({ ok: false, error: messageOf(error) })
  } finally {
    database.close()
  }
}
