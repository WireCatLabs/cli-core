// biome-ignore-all lint/plugin/no-sqlite-driver: cli-core owns the store, so it opens the driver itself
import type { DecisionPolicy } from "../decisions.js"
import { type CacheDatabase, PRAGMAS } from "../driver.js"
import { refuseOwnerStoreInTests } from "../path.js"
import { quietSqliteWarning } from "../sqlite-warning.js"
import { countWrites, shareCounts } from "../write-events.js"
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
  /** Who may decide proposals, set once by the host at open; every decide method reads it. */
  decisions?: DecisionPolicy
}

/**
 * One SQLite connection, seen two ways: the `CacheDatabase` seam the hand-written SQL and the
 * migration runner use, and Drizzle. Each Drizzle driver imports its runtime at the top of its
 * file, so both are loaded by dynamic `import()` in the branch that has that runtime — see
 * `../open.ts` for why a static import breaks the other runtime.
 */
export const openSqlite = async (
  path: string,
  { readOnly = false }: { readOnly?: boolean } = {},
): Promise<OpenedSqlite> => {
  refuseOwnerStoreInTests(path)
  const opened = "Bun" in globalThis ? await openUnderBun(path, readOnly) : await openUnderNode(path, readOnly)
  try {
    opened.database.exec(readOnly ? "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA query_only=ON" : PRAGMAS)
    return opened
  } catch (error) {
    opened.database.close()
    throw error
  }
}

const openUnderNode = async (path: string, readOnly: boolean): Promise<OpenedSqlite> => {
  quietSqliteWarning()
  const { drizzle } = await import("./drizzle/node.js")
  const { cacheOverNodeSqlite, nodeClient } = await import("../drivers/node-sqlite.js")
  const client = await nodeClient(path, { readOnly })
  try {
    if (!readOnly) countWrites(client, ["prepare"], () => client.isTransaction)
    const database = cacheOverNodeSqlite(client)
    shareCounts(client, database)
    return { database, orm: drizzle({ client }) as unknown as Orm }
  } catch (error) {
    client.close()
    throw error
  }
}

const openUnderBun = async (path: string, readOnly: boolean): Promise<OpenedSqlite> => {
  const { bunClient, cacheOverBunSqlite } = await import("../drivers/bun-sqlite.js")
  const { drizzle } = (await import("./drizzle/bun.js")) as unknown as {
    drizzle: (config: { client: unknown }) => unknown
  }
  const client = await bunClient(path, readOnly ? { readonly: true, create: false } : undefined)
  try {
    if (!readOnly)
      countWrites(client, ["prepare", "query"], () => (client as unknown as { inTransaction: boolean }).inTransaction)
    const database = cacheOverBunSqlite(client)
    shareCounts(client, database)
    return { database, orm: drizzle({ client }) as Orm }
  } catch (error) {
    client.close()
    throw error
  }
}
