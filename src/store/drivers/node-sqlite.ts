// biome-ignore-all lint/plugin/no-sqlite-driver: cli-core owns the store, so it opens the driver itself
import { DatabaseSync } from "node:sqlite"
import type { CacheDatabase, CacheStatement, SqlValue } from "../driver.js"
import { loadVectorExtension, vectorExtension } from "../vector-extension.js"

/**
 * Import this module only through a dynamic import that follows `quietSqliteWarning()`: a static import loads
 * `node:sqlite`, and on Node 22 its ExperimentalWarning, before the filter can run.
 */
export const openWithNodeSqlite = async (path: string): Promise<CacheDatabase> =>
  cacheOverNodeSqlite(await nodeClient(path))

/** A connection with the vector extension loaded; it closes again when the extension does not load. */
export const nodeClient = async (path: string, { readOnly = false }: { readOnly?: boolean } = {}) => {
  const extension = await vectorExtension()
  const client = new DatabaseSync(path, { readOnly, allowExtension: true })
  try {
    loadVectorExtension(client, extension)
    return client
  } catch (error) {
    client.close()
    throw error
  }
}

/**
 * Preparing is the expensive part of a call: the sync write path builds the same SQL text thousands of times, so each
 * connection keeps its statements, least recently used out first. Node's own `createTagStore` would do it, but it needs
 * Node 24.9 and template tags, not SQL text. An evicted statement is not finalized, because a caller may still hold
 * it; `close()` finalizes everything left. The seam must never offer `iterate`: callers share a cached statement, and
 * reusing a statement invalidates its open iterator.
 */
export const STATEMENT_CACHE_SIZE = 1000

export const cacheOverNodeSqlite = (database: DatabaseSync, cacheSize = STATEMENT_CACHE_SIZE): CacheDatabase => {
  const statements = new Map<string, CacheStatement>()
  const prepare = (sql: string): CacheStatement => {
    const statement = database.prepare(sql)
    return {
      run: (...parameters: SqlValue[]) => ({ changes: Number(statement.run(...parameters).changes) }),
      get: (...parameters: SqlValue[]) => statement.get(...parameters) as Record<string, unknown> | undefined,
      all: (...parameters: SqlValue[]) => statement.all(...parameters) as Record<string, unknown>[],
    }
  }
  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      const cached = statements.get(sql)
      if (cached) statements.delete(sql)
      const statement = cached ?? prepare(sql)
      statements.set(sql, statement)
      if (statements.size > cacheSize) statements.delete(statements.keys().next().value as string)
      return statement
    },
    close: () => {
      statements.clear()
      database.close()
    },
  }
}
