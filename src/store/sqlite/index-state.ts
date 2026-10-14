import type { CacheDatabase } from "../driver.js"

/** One index's row of `search_index_state`; `undefined` on a file before that index existed. */
export const indexRow = (database: CacheDatabase, name: string) => {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_index_state'").get()
  if (!exists) return undefined
  return database.prepare("SELECT * FROM search_index_state WHERE name = ?").get(name)
}
