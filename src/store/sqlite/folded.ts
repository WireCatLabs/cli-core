import type { CacheDatabase } from "../driver.js"
import { fold } from "../normalize.js"

/** Every name a list filter compares, beside its `fold()`ed copy: SQLite's `lower()` folds ASCII only. */
export const FOLDED = [
  { table: "tasks", column: "title" },
  { table: "tasks", column: "close_reason" },
  { table: "attachments", column: "name" },
  { table: "attachments", column: "local_path" },
  { table: "meetings", column: "title" },
] as const

export const folded = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : fold(value)

/** Fills the copies a file stored before they existed; each writer keeps its own from then on. */
export const fillFolded = (database: CacheDatabase): number => {
  let filled = 0
  for (const { table, column } of FOLDED) {
    const rows = database
      .prepare(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column}_folded IS NULL`)
      .all()
    const fill = database.prepare(`UPDATE ${table} SET ${column}_folded = ? WHERE id = ?`)
    for (const row of rows) fill.run(fold(String(row.value)), Number(row.id))
    filled += rows.length
  }
  return filled
}
