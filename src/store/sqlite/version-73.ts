import type { CacheDatabase } from "../driver.js"

/**
 * The pointer types each table's ids are named by, as version 73 found them (`ENTITY_TABLES`). Frozen: a type added
 * later points at rows made under AUTOINCREMENT already.
 */
const TYPES: Record<string, string[]> = {
  accounts: ["account"],
  attachments: ["attachment", "image"],
  bots: ["bot"],
  calendar_entries: ["calendar_entry"],
  canonical_tags: ["tag"],
  catalog_items: ["product"],
  chats: ["chat"],
  content_posts: ["post"],
  contracts: ["contract"],
  conversations: ["conversation"],
  deals: ["deal"],
  documents: ["document", "document_picture"],
  email_threads: ["email_thread"],
  emails: ["email", "email_enrichment"],
  event_series: ["event_series"],
  events: ["event"],
  facts: ["fact"],
  files: ["file"],
  financial_accounts: ["wallet"],
  financial_transactions: ["transaction"],
  identities: ["identity"],
  invoices: ["invoice"],
  leads: ["lead"],
  meeting_transcript_rows: ["meeting_transcript_row"],
  meeting_transcripts: ["meeting_transcript"],
  meetings: ["meeting"],
  memories: ["memory"],
  messages: ["message"],
  notes: ["note"],
  orders: ["order"],
  organizations: ["organization"],
  payments: ["payment"],
  persons: ["person"],
  pipelines: ["pipeline"],
  places: ["place"],
  projects: ["project"],
  subscriptions: ["subscription"],
  tasks: ["task"],
}

/** Ids kept outside a foreign key or a pointer pair. */
const NAMED_BY: Record<string, [table: string, column: string][]> = { facts: [["fact_removals", "fact_id"]] }

/** References the store cannot see (an agent's memory, a chat history, a Desktop page) get this much room. */
export const MARGIN = 1000

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

interface Shape {
  table: string
  pairs: [type: string, id: string][]
  references: [column: string, parent: string][]
}

const shapesOf = (database: CacheDatabase): Shape[] =>
  database
    .prepare(
      "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )
    .all()
    .map((row) => {
      const table = String(row.name)
      const columns = new Set(
        database
          .prepare("SELECT name FROM pragma_table_info(?)")
          .all(table)
          .map((column) => String(column.name)),
      )
      const pairs = [...columns].flatMap((column): [string, string][] => {
        const id = column.replace(/_type$/, "_id")
        return column.endsWith("_type") && columns.has(id) ? [[column, id]] : []
      })
      const references = database
        .prepare('SELECT "from", "table" FROM pragma_foreign_key_list(?)')
        .all(table)
        .map((fk): [string, string] => [String(fk.from), String(fk.table)])
      return { table, pairs, references }
    })

const highest = (database: CacheDatabase, sql: string, ...params: string[]): number =>
  Number(database.prepare(sql).get(...params)?.n ?? 0)

/** Every id the store knows was handed out for `table`: its rows, and what names them from anywhere in the file. */
const largestKnown = (database: CacheDatabase, table: string, shapes: Shape[]): number => {
  let top = highest(database, `SELECT max(id) AS n FROM ${quote(table)}`)
  top = Math.max(top, highest(database, "SELECT value AS n FROM store_settings WHERE key = ?", `ids.${table}.highest`))
  // A counter left by a rollback from 73 remembers ids handed out before it.
  top = Math.max(top, highest(database, "SELECT max(seq) AS n FROM sqlite_sequence WHERE name = ?", table))
  const types = TYPES[table] ?? []
  for (const shape of shapes) {
    for (const [column, parent] of shape.references)
      if (parent === table)
        top = Math.max(top, highest(database, `SELECT max(${quote(column)}) AS n FROM ${quote(shape.table)}`))
    for (const [typeColumn, idColumn] of shape.pairs)
      for (const type of types)
        top = Math.max(
          top,
          highest(
            database,
            `SELECT max(${quote(idColumn)}) AS n FROM ${quote(shape.table)} WHERE ${quote(typeColumn)} = ?`,
            type,
          ),
        )
  }
  for (const [other, column] of NAMED_BY[table] ?? [])
    if (shapes.some((shape) => shape.table === other))
      top = Math.max(top, highest(database, `SELECT max(${quote(column)}) AS n FROM ${quote(other)}`))
  return top
}

/**
 * Starts each copied table's counter above every id it ever handed out that the store can still see, plus `MARGIN`
 * for a store that had rows before; a new one has nothing outside it to name its rows.
 * The copy left a counter row only for tables with rows, and a stale one may be left by an earlier rollback, so each
 * row is deleted and inserted again; an `UPDATE` would miss both.
 */
export const seedSequences = (database: CacheDatabase, tables: string[], { margin }: { margin: boolean }): void => {
  const shapes = shapesOf(database)
  const seeds = tables.map((table) => [table, largestKnown(database, table, shapes) + (margin ? MARGIN : 0)] as const)
  const remove = database.prepare("DELETE FROM sqlite_sequence WHERE name = ?")
  const insert = database.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)")
  for (const [table, seed] of seeds) {
    remove.run(table)
    insert.run(table, seed)
  }
}
