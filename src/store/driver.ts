/**
 * The seam the two runtimes meet at.
 *
 * `node:sqlite` and `bun:sqlite` are different modules with different names, so a static import of
 * either one breaks the other runtime **at load time** — before any code runs and before anything
 * can catch it. The database is therefore handed in, the way the keyring and the clock already are
 * (`CONVENTIONS.md`: core takes its environment as arguments).
 *
 * The surface is deliberately tiny. Everything above it is ordinary SQL, so replacing the driver —
 * or adding a third — is writing thirty lines, not learning an abstraction.
 */

/** What SQLite itself can hold. Not `any`: a value it cannot store must fail to compile. */
export type SqlValue = string | number | bigint | null | Uint8Array

export interface CacheStatement {
  /** For writes. `changes` is how the fetch lease decides who won. */
  run(...parameters: SqlValue[]): { changes: number }
  get(...parameters: SqlValue[]): Record<string, unknown> | undefined
  all(...parameters: SqlValue[]): Record<string, unknown>[]
}

export interface CacheDatabase {
  exec(sql: string): void
  prepare(sql: string): CacheStatement
  close(): void
  /**
   * Set when the connection has `TIME_LIMIT_FUNCTION`. A statement runs to its end before any timer can fire, so a
   * long one is stopped from inside: `WHERE … AND wc_time_limit(<epoch ms>)` throws `TimeLimitReached` once past it.
   */
  timeLimit?: true
}

export const TIME_LIMIT_FUNCTION = "wc_time_limit"

export class TimeLimitReached extends Error {
  constructor() {
    super("the statement ran past its time limit")
    this.name = "TimeLimitReached"
  }
}

/** The SQL function's body: 1 until `until` (epoch milliseconds) has passed. */
export const beforeTimeLimit = (until: unknown): number => {
  if (Date.now() > Number(until)) throw new TimeLimitReached()
  return 1
}

export type OpenDatabase = (path: string) => CacheDatabase

/**
 * **Write-ahead mode, and a timeout rather than an instant failure.**
 *
 * Without the first, one writer freezes out every reader for the length of its write, and several
 * `max` invocations at once is the normal case here rather than the exception. Without the second,
 * a writer that finds the database busy fails immediately instead of waiting the moment out.
 *
 * `foreign_keys` is off by default in SQLite, which surprises everyone once.
 */
export const PRAGMAS = `
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
`

/** A read-only open sets `query_only`: a search over it reads what is indexed and leaves building it to a writable open. */
export const isQueryOnly = (database: CacheDatabase): boolean =>
  Number(Object.values(database.prepare("PRAGMA query_only").get() ?? {})[0]) === 1
