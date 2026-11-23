import type { CacheDatabase } from "../driver.js"
import { pointerPairs } from "./entity-types.js"

/** Who wrote or approved a row: the row is the writer's history, never silently rewritten. */
const AUTHORS = new Set(["author", "confirmed_by", "decided_by", "proposed_by", "actor", "closed_by"])

/** A link is about both ends: one that loses an end means nothing, so it goes. */
const LINK_ROWS = new Set(["links", "mentions", "task_assignments"])

const hasChildren = (database: CacheDatabase, table: string) =>
  database
    .prepare(
      `SELECT 1 FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND f."table" = ?
        LIMIT 1`,
    )
    .get(table) !== undefined

const nullable = (database: CacheDatabase, table: string, column: string) =>
  Number(database.prepare(`SELECT "notnull" AS n FROM pragma_table_info('${table}') WHERE name = ?`).get(column)?.n) ===
  0

export const count = (database: CacheDatabase, sql: string, ...params: (string | number)[]) =>
  Number(database.prepare(`SELECT count(*) AS n FROM ${sql}`).get(...params)?.n)

/**
 * What deleting an entity does to the rows that name it, read from the store's own `*_type`/`*_id` pointers and
 * foreign keys, so the plan shown and the delete run read one list. A row that only ties something to the entity
 * goes; one that can be without it loses the pointer; one that cannot, or that the entity wrote, blocks the delete.
 */
export class ErasePlan {
  readonly deleted: Record<string, number> = {}
  readonly detached: Record<string, number> = {}
  readonly blocked: string[] = []
  readonly #steps: (() => void)[] = []

  constructor(private readonly database: CacheDatabase) {}

  pointers(type: string, among: string, params: (string | number)[]): this {
    for (const { table, pointer } of pointerPairs(this.database)) {
      const where = `${pointer}_type = '${type}' AND ${pointer}_id IN (${among})`
      const n = count(this.database, `"${table}" WHERE ${where}`, ...params)
      if (n === 0) continue
      const key = `${table}.${pointer}`
      if (LINK_ROWS.has(table) || !nullable(this.database, table, `${pointer}_id`)) {
        if (!LINK_ROWS.has(table) && (AUTHORS.has(pointer) || hasChildren(this.database, table))) {
          this.blocked.push(`${n} ${table} (${pointer})`)
          continue
        }
        this.#add(this.deleted, key, n, `DELETE FROM "${table}" WHERE ${where}`, params)
      } else
        this.#add(
          this.detached,
          key,
          n,
          `UPDATE "${table}" SET ${pointer}_type = NULL, ${pointer}_id = NULL WHERE ${where}`,
          params,
        )
    }
    return this
  }

  /** Foreign keys to `target`, but those in `own`, which the caller deletes with the entity. */
  foreignKeys(target: string, id: number, own: ReadonlySet<string>): this {
    for (const row of this.database
      .prepare(
        `SELECT m.name AS tbl, f."from" AS col FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
          WHERE m.type = 'table' AND f."table" = ?`,
      )
      .all(target)) {
      const table = String(row.tbl)
      const column = String(row.col)
      if (own.has(table)) continue
      const n = count(this.database, `"${table}" WHERE "${column}" = ?`, id)
      if (n === 0) continue
      if (nullable(this.database, table, column))
        this.#add(
          this.detached,
          `${table}.${column}`,
          n,
          `UPDATE "${table}" SET "${column}" = NULL WHERE "${column}" = ?`,
          [id],
        )
      else this.blocked.push(`${n} ${table} (${column})`)
    }
    return this
  }

  run(): void {
    for (const step of this.#steps) step()
  }

  #add(into: Record<string, number>, key: string, n: number, sql: string, params: (string | number)[]) {
    into[key] = (into[key] ?? 0) + n
    this.#steps.push(() => this.database.prepare(sql).run(...params))
  }
}
