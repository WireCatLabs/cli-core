import { type CacheDatabase, PRAGMAS } from "../driver.js"
import type { SQLiteAsyncDatabase } from "./drizzle/core.js"

/** Drizzle over the store's connection. Synchronous inside: a transaction never awaits (plan D3). */
export type Orm = SQLiteAsyncDatabase<"sync", unknown>

export interface OpenedSqlite {
  database: CacheDatabase
  orm: Orm
}

/** What each query module of the store takes: the connection seen both ways, and the clock. */
export interface StoreContext extends OpenedSqlite {
  now: () => number
  /** The owner's shared config file, whose `task_categories` edits the store's list; none in a bare context. */
  sharedConfig?: string
}

/**
 * One SQLite connection, seen two ways: the `CacheDatabase` seam the hand-written SQL and the
 * migration runner use, and Drizzle. Each Drizzle driver imports its runtime at the top of its
 * file, so both are loaded by dynamic `import()` in the branch that has that runtime — see
 * `../open.ts` for why a static import breaks the other runtime.
 */
export const openSqlite = async (path: string): Promise<OpenedSqlite> => {
  const opened = "Bun" in globalThis ? await openUnderBun(path) : await openUnderNode(path)
  opened.database.exec(PRAGMAS)
  return opened
}

const openUnderNode = async (path: string): Promise<OpenedSqlite> => {
  const { DatabaseSync } = await import("node:sqlite")
  const { drizzle } = await import("./drizzle/node.js")
  const { cacheOverNodeSqlite } = await import("../drivers/node-sqlite.js")
  const client = new DatabaseSync(path)
  return { database: cacheOverNodeSqlite(client), orm: drizzle({ client }) as unknown as Orm }
}

const openUnderBun = async (path: string): Promise<OpenedSqlite> => {
  const { bunDatabase, cacheOverBunSqlite } = await import("../drivers/bun-sqlite.js")
  const Database = await bunDatabase()
  const { drizzle } = (await import("./drizzle/bun.js")) as unknown as {
    drizzle: (config: { client: unknown }) => unknown
  }
  const client = new Database(path)
  return { database: cacheOverBunSqlite(client), orm: drizzle({ client }) as Orm }
}
