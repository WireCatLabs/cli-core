import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"

/**
 * A migration drizzle-kit wrote as table copies (`CREATE TABLE __new_x`, copy, `DROP TABLE x`, rename). SQLite drops a
 * table's triggers and indexes with it, and fires `ON DELETE` actions on the drop unless foreign keys are off, which
 * they can only be outside a transaction. So the runner turns them off before `BEGIN` and this keeps the rest whole:
 * it refuses a table whose columns the copy would lose, settles the rows the new `CHECK`s would refuse, puts back
 * every trigger and index of the copied tables (other tools' included) and checks their foreign keys before `COMMIT`.
 */
export interface Rebuild {
  tables: { name: string; columns: string[] }[]
  checks: { table: string; name: string; expression: string }[]
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const unquote = (name: string) => name.replace(/^[`"]|[`"]$/g, "")

export const rebuildOf = (statements: string[]): Rebuild | undefined => {
  const tables: Rebuild["tables"] = []
  const checks: Rebuild["checks"] = []
  for (const statement of statements) {
    const created = /^CREATE TABLE `__new_(\w+)`/.exec(statement)
    if (created?.[1]) {
      const table = created[1]
      for (const found of statement.matchAll(/CONSTRAINT "(\w+)" CHECK\((.*)\)(?:,|\n\))/g))
        checks.push({ table, name: String(found[1]), expression: String(found[2]) })
    }
    const copied = /^INSERT INTO `__new_(\w+)`\(([^)]*)\) SELECT/.exec(statement)
    if (copied?.[1] && copied[2])
      tables.push({ name: copied[1], columns: copied[2].split(",").map((column) => unquote(column.trim())) })
  }
  return tables.length > 0 ? { tables, checks } : undefined
}

export const rebuilds = (statements: string[]): boolean => rebuildOf(statements) !== undefined

export interface Saved {
  objects: { name: string; sql: string }[]
  notes: string[]
  /** References that already pointed at missing rows before the copy, by `referenceKey`. */
  broken: Set<string>
}

interface Dangling {
  table: string
  rowid: number
  parent: string
  column: string
}

/**
 * By the referring columns, not `fkid`: the copy may list the foreign keys in another order. Each copied table has an
 * integer `id`, so its rowid survives the copy.
 */
const referenceKey = ({ table, rowid, parent, column }: Dangling) =>
  `${table}\u0000${rowid}\u0000${parent}\u0000${column}`

const danglingIn = (database: CacheDatabase, tables: string[]): Dangling[] =>
  tables.flatMap((table) => {
    const rows = database.prepare(`PRAGMA foreign_key_check(${quote(table)})`).all()
    if (rows.length === 0) return []
    const columns = new Map<number, string[]>()
    for (const fk of database.prepare('SELECT id, "from" FROM pragma_foreign_key_list(?) ORDER BY id, seq').all(table))
      columns.set(Number(fk.id), [...(columns.get(Number(fk.id)) ?? []), String(fk.from)])
    return rows.map((row) => ({
      table,
      rowid: Number(row.rowid),
      parent: String(row.parent),
      column: (columns.get(Number(row.fkid)) ?? []).join(", "),
    }))
  })

interface DanglingGroup {
  table: string
  column: string
  parent: string
  rows: number
  ids: number[]
}

const grouped = (dangling: Dangling[]): DanglingGroup[] => {
  const groups = new Map<string, DanglingGroup>()
  for (const { table, rowid, parent, column } of dangling) {
    const key = `${table}\u0000${column}\u0000${parent}`
    const group = groups.get(key) ?? { table, column, parent, rows: 0, ids: [] }
    group.rows += 1
    if (group.ids.length < KEPT_IDS) group.ids.push(rowid)
    groups.set(key, group)
  }
  return [...groups.values()]
}

const described = ({ table, column, parent, rows, ids }: DanglingGroup) =>
  `${table}.${column} in ${rows === 1 ? "1 row" : `${rows} rows`} (${listed(ids)}) → ${parent}`

const columnsOf = (database: CacheDatabase, table: string): string[] =>
  database
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map((row) => String(row.name))

const idsOf = (database: CacheDatabase, table: string, where: string): number[] =>
  database
    .prepare(`SELECT id FROM ${quote(table)} WHERE ${where} ORDER BY id`)
    .all()
    .map((row) => Number(row.id))

const listed = (ids: number[]) =>
  ids.length > 20 ? `${ids.slice(0, 20).join(", ")} and ${ids.length - 20} more` : ids.join(", ")

const KEPT_IDS = 1000

const JSON_RULE = /^"(\w+)" IS NULL OR json_valid\("\1"\)$/

/**
 * Inside the transaction, before the statements. Invalid JSON is kept whole as a JSON string (`json_quote`), and the
 * repair is reported and kept in `store_settings`; any other row a new `CHECK` refuses stops the migration, naming it.
 */
export const beforeRebuild = (database: CacheDatabase, rebuild: Rebuild, version: number, now: number): Saved => {
  const names = rebuild.tables.map(({ name }) => name)
  for (const { name, columns } of rebuild.tables) {
    const kept = new Set(columns)
    const lost = columnsOf(database, name).filter((column) => !kept.has(column))
    if (lost.length > 0)
      throw new CliError(
        "configuration_error",
        `schema ${version} copies ${name} without its columns ${lost.join(", ")}, which this store has and this build does not know — nothing was changed`,
        { reason: "store.unknown-columns" },
      )
  }
  const objects = database
    .prepare(
      `SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL
       AND tbl_name IN (${names.map(() => "?").join(", ")}) ORDER BY rowid`,
    )
    .all(...names)
    .map((row) => ({ type: String(row.type), name: String(row.name), sql: String(row.sql) }))
  // The repairs below must not fire them; they come back after the copy.
  for (const { type, name } of objects) if (type === "trigger") database.exec(`DROP TRIGGER ${quote(name)}`)
  const repaired: { table: string; column: string; rows: number; ids: number[] }[] = []
  const refused: string[] = []
  for (const { table, name, expression } of rebuild.checks) {
    const ids = idsOf(database, table, `NOT (${expression})`)
    if (ids.length === 0) continue
    const column = JSON_RULE.exec(expression)?.[1]
    if (column) {
      database.exec(
        `UPDATE ${quote(table)} SET ${quote(column)} = json_quote(${quote(column)}) WHERE NOT (${expression})`,
      )
      repaired.push({ table, column, rows: ids.length, ids: ids.slice(0, KEPT_IDS) })
    } else {
      refused.push(`${table} rows ${listed(ids)} break ${name} (${expression})`)
    }
  }
  if (refused.length > 0)
    throw new CliError(
      "configuration_error",
      `the store holds rows schema ${version} refuses, so it was not migrated and nothing was changed: ${refused.join("; ")}. ` +
        "Correct or delete those rows (an older tool still opens the store, and so does sqlite3), then open it again",
      { reason: "store.rows-break-checks" },
    )
  const notes = repaired.map(
    ({ table, column, rows, ids }) =>
      `${table}.${column} held text that is not JSON in ${rows === 1 ? "1 row" : `${rows} rows`} (${listed(ids)}); each is kept whole as a JSON string`,
  )
  if (repaired.length > 0)
    database
      .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
      .run(`migration:${version}:repaired`, JSON.stringify(repaired), now)
  // Rows a sync or an older tool left pointing at deleted rows: the copy keeps them as they are, and says so.
  const dangling = danglingIn(database, names)
  if (dangling.length > 0) {
    const groups = grouped(dangling)
    notes.push(
      `these references already pointed at rows that do not exist, and are kept as they were: ${groups.map(described).join("; ")}`,
    )
    database
      .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
      .run(`migration:${version}:broken-references`, JSON.stringify(groups), now)
  }
  return { objects, notes, broken: new Set(dangling.map(referenceKey)) }
}

/** After the statements, still inside the transaction. */
export const afterRebuild = (database: CacheDatabase, rebuild: Rebuild, saved: Saved, version: number): void => {
  const present = new Set(
    database
      .prepare("SELECT name FROM sqlite_master")
      .all()
      .map((row) => String(row.name)),
  )
  for (const { name, sql } of saved.objects) if (!present.has(name)) database.exec(sql)
  const broken = danglingIn(
    database,
    rebuild.tables.map(({ name }) => name),
  ).filter((reference) => !saved.broken.has(referenceKey(reference)))
  if (broken.length > 0)
    throw new CliError(
      "configuration_error",
      `the migration to schema ${version} would break these references, so it was not run and nothing was changed: ` +
        `${grouped(broken).map(described).join("; ")}. The store is whole and the tool you used before still opens ` +
        "it; keep using that one and report this at https://github.com/WireCatLabs/cli-core/issues",
      { reason: "store.foreign-keys" },
    )
}

/** Outside any transaction: SQLite ignores `foreign_keys` inside one. */
export const pauseForeignKeys = (database: CacheDatabase): (() => void) => {
  database.exec("PRAGMA foreign_keys = OFF")
  return () => database.exec("PRAGMA foreign_keys = ON")
}

/**
 * Around the copies only: a rename must not rewrite, or fail on, the triggers and views of other tables that name the
 * copied one. An earlier migration in the same run renames tables and relies on exactly that rewrite.
 */
export const legacyRenames = (database: CacheDatabase, on: boolean): void => {
  database.exec(`PRAGMA legacy_alter_table = ${on ? "ON" : "OFF"}`)
}

export const foreignKeysOff = (database: CacheDatabase): boolean =>
  Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys) === 0
