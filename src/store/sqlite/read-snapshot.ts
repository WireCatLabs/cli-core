import type { CacheDatabase } from "../driver.js"

/** Multi-query reads must stay coherent without draining the derived-write queue. */
export const readSnapshot = <T>(database: CacheDatabase, body: () => T): T => {
  database.exec("SAVEPOINT read_snapshot")
  try {
    const result = body()
    database.exec("RELEASE read_snapshot")
    return result
  } catch (error) {
    database.exec("ROLLBACK TO read_snapshot; RELEASE read_snapshot")
    throw error
  }
}
