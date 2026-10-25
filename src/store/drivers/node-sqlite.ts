// biome-ignore-all lint/plugin/no-sqlite-driver: cli-core owns the store, so it opens the driver itself
import { DatabaseSync } from "node:sqlite"
import type { CacheDatabase, SqlValue } from "../driver.js"
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

export const cacheOverNodeSqlite = (database: DatabaseSync): CacheDatabase => {
  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      const statement = database.prepare(sql)
      return {
        run: (...parameters: SqlValue[]) => ({ changes: Number(statement.run(...parameters).changes) }),
        get: (...parameters: SqlValue[]) => statement.get(...parameters) as Record<string, unknown> | undefined,
        all: (...parameters: SqlValue[]) => statement.all(...parameters) as Record<string, unknown>[],
      }
    },
    close: () => database.close(),
  }
}
