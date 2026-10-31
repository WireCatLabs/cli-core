import type { Stemmer, Stemmers } from "../../search/stem.js"
import type { CacheDatabase } from "../driver.js"
import { drainInvolvementQueue } from "./involvement-queue.js"
import { drainMentions } from "./mention-drain.js"
import { drainStems, stemmerCache } from "./stems.js"

type Connection = { depth: number; reading: boolean; stemmerFor: (stemmers: Stemmers) => Stemmer }

const SQLITE_BUSY = 5
const pause = new Int32Array(new SharedArrayBuffer(4))

const isBusy = (error: unknown): boolean => {
  const { errcode, errno } = (error ?? {}) as { errcode?: unknown; errno?: unknown }
  const code = errcode ?? errno
  return typeof code === "number" && (code & 0xff) === SQLITE_BUSY
}

/**
 * Takes the write lock, waiting as long as the connection's `busy_timeout`. SQLite's own wait sleeps 1 ms, then up to
 * 100 ms between tries, so a process that commits and begins again at once is never seen free and the waiter fails
 * with "database is locked" after the full timeout. Trying every millisecond sees a gap of a fraction of a
 * millisecond between two writes; a writer that leaves none still starves it, hence `writeBatch`'s pause.
 */
const beginImmediate = (database: CacheDatabase): void => {
  const timeout = Number(database.prepare("PRAGMA busy_timeout").get()?.timeout ?? 0)
  const deadline = Date.now() + timeout
  database.exec("PRAGMA busy_timeout = 0")
  try {
    for (;;) {
      try {
        database.exec("BEGIN IMMEDIATE")
        return
      } catch (error) {
        if (!isBusy(error) || Date.now() >= deadline) throw error
        Atomics.wait(pause, 0, 0, 1)
      }
    }
  } finally {
    database.exec(`PRAGMA busy_timeout = ${timeout}`)
  }
}

const connections = new WeakMap<CacheDatabase, Connection>()

const connectionOf = (database: CacheDatabase): Connection => {
  let connection = connections.get(database)
  if (!connection) {
    connection = { depth: 0, reading: false, stemmerFor: stemmerCache() }
    connections.set(database, connection)
  }
  return connection
}

/**
 * One write transaction. The outermost takes the write lock at once (`BEGIN IMMEDIATE`): a deferred one that
 * reads first fails with SQLITE_BUSY when another process writes in between, and tg, max, memo and zm share
 * the file. A nested call is a savepoint. The outermost recomputes what the triggers queued (stems, mentions,
 * involvements) before it commits. `beforeCommit` runs after that, so a check there can still roll it back.
 */
export const write = <T>(
  database: CacheDatabase,
  body: () => T,
  { beforeCommit }: { beforeCommit?: () => void } = {},
) => transact(database, body, true, beforeCommit)

/**
 * A write to tables that queue no derived work, in a loop that budgets its lock time or reports what it did: a fill,
 * a backfill, a rebuild. It drains nothing, so it neither does nor hides another write's work; the queues wait for
 * the next `write`. The outermost pauses 2 ms after it commits: a loop that begins again at once leaves another
 * process's `write` a gap of microseconds, and it misses that gap until its 5 s wait runs out.
 */
export const writeBatch = <T>(database: CacheDatabase, body: () => T): T => {
  const outer = connectionOf(database).depth === 0
  const result = transact(database, body, false)
  if (outer) Atomics.wait(pause, 0, 0, BATCH_PAUSE_MS)
  return result
}

const BATCH_PAUSE_MS = 2

const transact = <T>(database: CacheDatabase, body: () => T, drain: boolean, beforeCommit?: () => void): T => {
  const connection = connectionOf(database)
  if (connection.reading) throw new Error("a store write cannot run inside a read")
  const outer = connection.depth === 0
  const name = `w${connection.depth + 1}`
  if (outer) beginImmediate(database)
  else database.exec(`SAVEPOINT ${name}`)
  connection.depth += 1
  try {
    const result = body()
    if (outer && drain) {
      drainStems(database, connection.stemmerFor)
      drainMentions(database, Date.now())
      drainInvolvementQueue(database)
    }
    beforeCommit?.()
    database.exec(outer ? "COMMIT" : `RELEASE ${name}`)
    return result
  } catch (error) {
    database.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`)
    throw error
  } finally {
    connection.depth -= 1
  }
}

/** Several queries that must see one state of the file. Never drains: that is the outer write's work, or nobody's. */
export const read = <T>(database: CacheDatabase, body: () => T): T => {
  const connection = connectionOf(database)
  const outer = connection.depth === 0
  const name = `r${connection.depth + 1}`
  database.exec(`SAVEPOINT ${name}`)
  connection.depth += 1
  if (outer) connection.reading = true
  try {
    const result = body()
    database.exec(`RELEASE ${name}`)
    return result
  } catch (error) {
    database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`)
    throw error
  } finally {
    connection.depth -= 1
    if (outer) connection.reading = false
  }
}
