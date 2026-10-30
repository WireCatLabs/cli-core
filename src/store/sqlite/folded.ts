import type { CacheDatabase } from "../driver.js"
import { fold } from "../normalize.js"
import { writeBatch } from "./transaction.js"

/**
 * Every name a filter compares, beside its `fold()`ed copy: SQLite's `lower()`, `NOCASE` and `LIKE` fold ASCII only,
 * and Bun cannot register a function that folds the rest. A writer sets the copy; a trigger empties a copy whose name
 * changed without it (version 38), and `fillFolded` refills it on the next open.
 */
export const FOLDED = [
  { table: "tasks", column: "title" },
  { table: "tasks", column: "close_reason" },
  { table: "attachments", column: "name" },
  { table: "attachments", column: "local_path" },
  { table: "meetings", column: "title" },
  { table: "files", column: "path" },
  { table: "projects", column: "name" },
  { table: "chats", column: "title" },
  { table: "identities", column: "name" },
  { table: "email_threads", column: "subject" },
  { table: "mailboxes", column: "name" },
] as const

export const folded = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : fold(value)

/**
 * Fills the copies still empty: rows stored before version 8, and rows an older build writes into a store a newer one
 * migrated — it does not know the columns. Run on every open; each batch is its own short write, so another process
 * waits for one batch at most, and a store with nothing to fill costs one index probe per column (version 9).
 */
export const fillFolded = (database: CacheDatabase, { batch = 2_000 }: { batch?: number } = {}): number => {
  let filled = 0
  for (const { table, column } of FOLDED) {
    const pending = database.prepare(
      `SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column}_folded IS NULL LIMIT ?`,
    )
    if (pending.get(1) === undefined) continue
    const fill = database.prepare(`UPDATE ${table} SET ${column}_folded = ? WHERE id = ?`)
    for (;;) {
      const count = writeBatch(database, () => {
        const rows = pending.all(batch)
        for (const row of rows) fill.run(fold(String(row.value)), Number(row.id))
        return rows.length
      })
      filled += count
      if (count < batch) break
    }
  }
  return filled
}
