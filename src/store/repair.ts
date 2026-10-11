import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "./driver.js"
import { MIGRATIONS, migrate } from "./migrations.js"

export const COPY_MARK = "__repair_"
const COPY_NAME = /__repair_[0-9a-f]{8}(_\d+)?$/

interface Column {
  name: string
  type: string
  notNull: boolean
  defaultValue: string | null
  pk: number
  hidden: number
}

interface Shape {
  sql: string
  columns: Column[]
  foreignKeys: string[]
  /** UNIQUE and PRIMARY KEY constraints, which live in the table's own definition. */
  constraints: string[]
  /** `CREATE INDEX` / `CREATE TRIGGER` statements by name. */
  indexes: Map<string, string>
  triggers: Map<string, string>
}

export interface TableRepair {
  table: string
  action: "created" | "columns-added" | "rebuilt"
  columnsAdded?: string[]
  copy?: string
  rowsInCopy?: number
  rowsCopied?: number
  /** Columns the copy holds that the new table does not: their data is only in the copy. */
  onlyInCopy?: string[]
  /** Indexes and triggers of the copy dropped because the new table needs their names; they hold no data. */
  droppedFromCopy?: string[]
}

export interface Mismatch {
  table: string
  what: string
}

export interface RepairReport {
  dryRun: boolean
  repaired: TableRepair[]
  indexesCreated: string[]
  triggersCreated: string[]
  mismatches: Mismatch[]
  foreignKeyViolations: { table: string; rows: number }[]
  copies: { name: string; rows: number }[]
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`

const rowsOf = (database: CacheDatabase, sql: string) => database.prepare(sql).all()

/** Virtual tables, their shadow tables and SQLite's own are the indexes' business, not this check's. */
const plainTables = (database: CacheDatabase): Map<string, string> => {
  const all = rowsOf(database, "SELECT name, sql FROM sqlite_master WHERE type = 'table'").map((row) => ({
    name: String(row.name),
    sql: String(row.sql ?? ""),
  }))
  const virtual = all.filter((one) => /^CREATE VIRTUAL TABLE/i.test(one.sql)).map((one) => one.name)
  return new Map(
    all
      .filter(({ name, sql }) => !name.startsWith("sqlite_") && !/^CREATE VIRTUAL TABLE/i.test(sql))
      .filter(({ name }) => !virtual.some((one) => name.startsWith(`${one}_`)))
      .map(({ name, sql }) => [name, sql]),
  )
}

const shapeOf = (database: CacheDatabase, table: string, sql: string): Shape => {
  const columns = rowsOf(database, `SELECT * FROM pragma_table_xinfo(${literal(table)})`).map((row) => ({
    name: String(row.name),
    type: String(row.type ?? "").toUpperCase(),
    notNull: Number(row.notnull) === 1,
    defaultValue: row.dflt_value === null ? null : String(row.dflt_value),
    pk: Number(row.pk),
    hidden: Number(row.hidden),
  }))
  const foreignKeys = rowsOf(database, `SELECT * FROM pragma_foreign_key_list(${literal(table)})`)
    .map((row) => `${row.from}→${row.table}.${row.to} on delete ${row.on_delete}`)
    .sort()
  const constraints = rowsOf(database, `SELECT name, "unique", origin FROM pragma_index_list(${literal(table)})`)
    .filter((row) => row.origin !== "c")
    .map((row) => {
      const keys = rowsOf(database, `SELECT name FROM pragma_index_info(${literal(String(row.name))}) ORDER BY seqno`)
      return `${row.origin} (${keys.map((key) => String(key.name)).join(", ")})`
    })
    .sort()
  const named = (type: string) =>
    new Map(
      rowsOf(database, `SELECT name, sql FROM sqlite_master WHERE type = '${type}' AND tbl_name = ${literal(table)}`)
        .filter((row) => row.sql !== null)
        .map((row) => [String(row.name), String(row.sql)]),
    )
  return { sql, columns, foreignKeys, constraints, indexes: named("index"), triggers: named("trigger") }
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((one, index) => one === b[index])

const columnDiffers = (one: Column, other: Column) =>
  one.type !== other.type ||
  one.notNull !== other.notNull ||
  one.defaultValue !== other.defaultValue ||
  one.pk !== other.pk ||
  one.hidden !== other.hidden

/** A column `ALTER TABLE ADD COLUMN` can add as it is: nullable or defaulted, not a key, not generated. */
const addable = (column: Column, expected: Shape) =>
  (!column.notNull || column.defaultValue !== null) &&
  column.pk === 0 &&
  column.hidden === 0 &&
  !expected.foreignKeys.some((key) => key.startsWith(`${column.name}→`))

const definitionOf = (column: Column) =>
  [
    quote(column.name),
    column.type,
    column.notNull ? "NOT NULL" : "",
    column.defaultValue === null ? "" : `DEFAULT ${column.defaultValue}`,
  ]
    .filter((part) => part.length > 0)
    .join(" ")

type Plan =
  | { table: string; kind: "create" }
  | { table: string; kind: "add"; columns: Column[] }
  | { table: string; kind: "rebuild" }

const planFor = (expected: Shape, actual: Shape | undefined, table: string): Plan | undefined => {
  if (actual === undefined) return { table, kind: "create" }
  const have = new Map(actual.columns.map((column) => [column.name, column]))
  const missing = expected.columns.filter((column) => !have.has(column.name))
  const extra = actual.columns.filter((column) => !expected.columns.some((one) => one.name === column.name))
  const changed = expected.columns.some((column) => {
    const theirs = have.get(column.name)
    return theirs !== undefined && columnDiffers(column, theirs)
  })
  const keysDiffer = !same(
    expected.foreignKeys,
    actual.foreignKeys.filter((key) => !missing.some((column) => key.startsWith(`${column.name}→`))),
  )
  if (!changed && extra.length === 0 && !keysDiffer && same(expected.constraints, actual.constraints)) {
    if (missing.length === 0) return undefined
    if (missing.every((column) => addable(column, expected))) return { table, kind: "add", columns: missing }
  }
  return { table, kind: "rebuild" }
}

/** Parents before children, so a copied child row finds its parent already there. */
const parentsFirst = (plans: Plan[], expected: Map<string, Shape>): Plan[] => {
  const order: Plan[] = []
  const placing = new Set<string>()
  const place = (plan: Plan) => {
    if (order.includes(plan) || placing.has(plan.table)) return
    placing.add(plan.table)
    for (const key of expected.get(plan.table)?.foreignKeys ?? []) {
      const parent = key.split("→")[1]?.split(".")[0]
      const first = plans.find((one) => one.table === parent)
      if (first) place(first)
    }
    order.push(plan)
  }
  for (const plan of plans) place(plan)
  return order
}

const copyNameFor = (database: CacheDatabase, table: string, sql: string) => {
  const base = `${table}${COPY_MARK}${createHash("sha256").update(sql).digest("hex").slice(0, 8)}`
  const taken = (name: string) => database.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name) !== undefined
  if (!taken(base)) return base
  let n = 2
  while (taken(`${base}_${n}`)) n += 1
  return `${base}_${n}`
}

const count = (database: CacheDatabase, table: string) =>
  Number(database.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get()?.n ?? 0)

/** The shape this build's migrations give a new file. */
const expectedShapes = (fresh: CacheDatabase): Map<string, Shape> => {
  migrate(fresh, { migrations: MIGRATIONS })
  return new Map([...plainTables(fresh)].map(([name, sql]) => [name, shapeOf(fresh, name, sql)]))
}

/**
 * **Brings each table of the file to the shape this build's migrations give it, deleting nothing**
 * (NEED-626). A table only missing columns it can take gets them added; any other difference keeps
 * the table as a copy named `<table>__repair_<hash>` beside a new one holding every row that fits.
 * `messages` is never renamed — its search index and triggers hang off it — so a difference there
 * is reported, not rebuilt. With `dryRun` the same work runs and is rolled back, so the report is
 * exact.
 */
export const repairStore = (
  database: CacheDatabase,
  fresh: CacheDatabase,
  { dryRun = false }: { dryRun?: boolean } = {},
): RepairReport => {
  if (dryRun) {
    // A dry run changes nothing, so it cannot migrate first; a file behind would compare as broken.
    const tracked = database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get()
    const version = tracked
      ? Number(database.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version ?? 0)
      : 0
    if (version < (MIGRATIONS.at(-1)?.version ?? 0)) {
      throw new CliError(
        "validation_error",
        "the store is behind this build — `store migrate` first, then `store repair --dry-run`",
      )
    }
  } else migrate(database)
  const expected = expectedShapes(fresh)
  const actualSql = plainTables(database)
  const actual = new Map([...actualSql].map(([name, sql]) => [name, shapeOf(database, name, sql)]))

  const mismatches: Mismatch[] = []
  const plans = [...expected]
    .map(([table, shape]) => planFor(shape, actual.get(table), table))
    .filter((plan): plan is Plan => plan !== undefined)
    .filter((plan) => {
      if (plan.kind === "rebuild" && plan.table === "messages") {
        mismatches.push({
          table: "messages",
          what: "differs from this build's shape in a way columns alone cannot fix; left as it is",
        })
        return false
      }
      return true
    })

  const report: RepairReport = {
    dryRun,
    repaired: [],
    indexesCreated: [],
    triggersCreated: [],
    mismatches,
    foreignKeyViolations: [],
    copies: [],
  }

  // Off outside a transaction, or SQLite ignores it: a copied child may precede what it points at,
  // and a rename must leave other tables' keys pointing at the new table, not the copy.
  database.exec("PRAGMA foreign_keys = OFF")
  database.exec("PRAGMA legacy_alter_table = ON")
  database.exec("BEGIN IMMEDIATE")
  try {
    for (const plan of parentsFirst(plans, expected)) {
      const shape = expected.get(plan.table) as Shape
      if (plan.kind === "create") {
        database.exec(shape.sql)
        report.repaired.push({ table: plan.table, action: "created" })
        continue
      }
      if (plan.kind === "add") {
        for (const column of plan.columns)
          database.exec(`ALTER TABLE ${quote(plan.table)} ADD COLUMN ${definitionOf(column)}`)
        report.repaired.push({
          table: plan.table,
          action: "columns-added",
          columnsAdded: plan.columns.map((one) => one.name),
        })
        continue
      }
      const old = actual.get(plan.table) as Shape
      const copy = copyNameFor(database, plan.table, old.sql)
      database.exec(`ALTER TABLE ${quote(plan.table)} RENAME TO ${quote(copy)}`)
      const dropped: string[] = []
      for (const [name] of old.indexes) {
        if ([...expected.values()].some((one) => one.indexes.has(name))) {
          database.exec(`DROP INDEX ${quote(name)}`)
          dropped.push(name)
        }
      }
      for (const [name] of old.triggers) {
        if ([...expected.values()].some((one) => one.triggers.has(name))) {
          database.exec(`DROP TRIGGER ${quote(name)}`)
          dropped.push(name)
        }
      }
      database.exec(shape.sql)
      const writable = shape.columns.filter((column) => column.hidden === 0).map((column) => column.name)
      const common = old.columns
        .filter((column) => column.hidden === 0 && writable.includes(column.name))
        .map((column) => quote(column.name))
        .join(", ")
      const rowsInCopy = count(database, copy)
      const rowsCopied =
        common.length === 0
          ? 0
          : database
              .prepare(`INSERT OR IGNORE INTO ${quote(plan.table)} (${common}) SELECT ${common} FROM ${quote(copy)}`)
              .run().changes
      report.repaired.push({
        table: plan.table,
        action: "rebuilt",
        copy,
        rowsInCopy,
        rowsCopied,
        onlyInCopy: old.columns.filter((column) => !writable.includes(column.name)).map((column) => column.name),
        droppedFromCopy: dropped,
      })
    }

    for (const [table, shape] of expected) {
      for (const [name, sql] of shape.indexes) {
        if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)) continue
        try {
          database.exec(sql)
          report.indexesCreated.push(name)
        } catch (error) {
          mismatches.push({
            table,
            what: `index ${name} could not be created: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      }
      for (const [name, sql] of shape.triggers) {
        if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name)) continue
        try {
          database.exec(sql)
          report.triggersCreated.push(name)
        } catch (error) {
          mismatches.push({
            table,
            what: `trigger ${name} could not be created: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      }
    }

    const now = plainTables(database)
    for (const [table, shape] of expected) {
      const sql = now.get(table)
      if (sql === undefined) continue
      const theirs = shapeOf(database, table, sql)
      for (const [name, indexSql] of theirs.indexes) {
        const wanted = shape.indexes.get(name)
        if (wanted === undefined) mismatches.push({ table, what: `index ${name} is not in this build's shape` })
        else if (wanted !== indexSql) mismatches.push({ table, what: `index ${name} is defined differently` })
      }
      if (planFor(shape, theirs, table) !== undefined && table !== "messages") {
        mismatches.push({ table, what: "still differs from this build's shape" })
      }
    }
    const violations = new Map<string, number>()
    for (const row of rowsOf(database, "PRAGMA foreign_key_check")) {
      violations.set(String(row.table), (violations.get(String(row.table)) ?? 0) + 1)
    }
    report.foreignKeyViolations = [...violations].map(([table, rows]) => ({ table, rows }))
    report.copies = copiesIn(database)

    database.exec(dryRun ? "ROLLBACK" : "COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  } finally {
    database.exec("PRAGMA legacy_alter_table = OFF")
    database.exec("PRAGMA foreign_keys = ON")
  }
  return report
}

/** Every repair copy in the file, with its rows. */
export const copiesIn = (database: CacheDatabase): { name: string; rows: number }[] =>
  rowsOf(database, `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%${COPY_MARK}%'`)
    .map((row) => String(row.name))
    .filter((name) => COPY_NAME.test(name))
    .sort()
    .map((name) => ({ name, rows: count(database, name) }))

/** Deletes one repair copy, named exactly; refuses anything else. */
export const deleteCopy = (database: CacheDatabase, name: string): { name: string; rows: number } => {
  const found = copiesIn(database).find((one) => one.name === name)
  if (found === undefined) {
    throw new CliError(
      "not_found",
      `"${name}" is not a repair copy in this store — \`store repair --dry-run\` lists the copies`,
    )
  }
  database.exec("PRAGMA foreign_keys = OFF")
  try {
    database.exec(`DROP TABLE ${quote(name)}`)
  } finally {
    database.exec("PRAGMA foreign_keys = ON")
  }
  return found
}
