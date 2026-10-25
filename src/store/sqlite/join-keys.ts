import { joinKeyOf } from "../../meetings/index.js"
import type { CacheDatabase } from "../driver.js"
import { writeBatch } from "./transaction.js"

/**
 * Fills `meetings.join_key` where it is empty: meetings stored before version 33, and those a build of version 32
 * writes, which does not know the column. On every open; a store with nothing to fill costs one index probe.
 */
export const fillJoinKeys = (database: CacheDatabase, { batch = 2_000 }: { batch?: number } = {}): number => {
  const pending = database.prepare(
    "SELECT id, join_url FROM meetings WHERE join_url IS NOT NULL AND join_key IS NULL AND id > ? ORDER BY id LIMIT ?",
  )
  if (pending.get(0, 1) === undefined) return 0
  // A link that names no room keeps an empty key, so it is not read again on every open.
  const fill = database.prepare("UPDATE meetings SET join_key = ? WHERE id = ?")
  let filled = 0
  let after = 0
  for (;;) {
    const rows = writeBatch(database, () => {
      const page = pending.all(after, batch)
      for (const row of page) fill.run(joinKeyOf(String(row.join_url)) ?? "", Number(row.id))
      return page
    })
    filled += rows.length
    if (rows.length < batch) return filled
    after = Number(rows.at(-1)?.id)
  }
}
