import type { StoreEvent } from "../runs/events.js"
import { runEvent } from "../runs/scope.js"

type Target = { table: string; op: StoreEvent["op"] }

const WRITE =
  /^\s*(?:WITH\b[\s\S]*?\)\s*)?(INSERT|REPLACE|UPDATE|DELETE)\b(?:\s+OR\s+[A-Za-z]+)?\s+(?:INTO\s+|FROM\s+)?(?:("?)(\w+)\2\.)?["`[]?(\w+)/i

/** The table a statement writes and how, read from its text; a read, DDL or a temp table answers undefined. */
export const writeTarget = (sql: string): Target | undefined => {
  const match = WRITE.exec(sql)
  if (!match || match[3]?.toLowerCase() === "temp") return undefined
  const verb = (match[1] as string).toUpperCase()
  return { table: match[4] as string, op: verb === "UPDATE" ? "update" : verb === "DELETE" ? "delete" : "insert" }
}

interface Tally {
  pending: Map<string, Target & { n: number }>
  inTransaction: () => boolean
}

const tallies = new WeakMap<object, Tally>()
const wrapped = new WeakSet<object>()

const emit = ({ table, op, n }: Target & { n: number }) =>
  runEvent({ event: "store", operation: "store.write", kind: "store", table, op, n })

const note = (tally: Tally, target: Target, n: number) => {
  if (n <= 0) return
  // Outside a transaction the statement committed itself.
  if (!tally.inTransaction()) return emit({ ...target, n })
  const key = `${target.table} ${target.op}`
  const seen = tally.pending.get(key)
  if (seen) seen.n += n
  else tally.pending.set(key, { ...target, n })
}

type Statement = Record<"run" | "all" | "get", (...parameters: unknown[]) => unknown>

const count = (statement: Statement, target: Target, tally: Tally) => {
  if (wrapped.has(statement)) return
  wrapped.add(statement)
  const { run, all, get } = statement
  statement.run = (...parameters) => {
    const result = run.apply(statement, parameters) as { changes: number | bigint }
    note(tally, target, Number(result.changes))
    return result
  }
  statement.all = (...parameters) => {
    const rows = all.apply(statement, parameters) as unknown[]
    note(tally, target, rows.length)
    return rows
  }
  statement.get = (...parameters) => {
    const row = get.apply(statement, parameters)
    note(tally, target, row === undefined || row === null ? 0 : 1)
    return row
  }
}

/**
 * Counts the rows each write statement changes, per table, on a writable store connection: `methods` are the client's
 * prepare calls, which both the `CacheDatabase` seam and Drizzle go through. A transaction's counts become run events
 * when `write` commits it; a statement outside one is its own event.
 */
export const countWrites = <C extends object>(
  client: C,
  methods: readonly string[],
  inTransaction: () => boolean,
): C => {
  const tally: Tally = { pending: new Map(), inTransaction }
  const target = client as Record<string, unknown>
  const shared = Object.getPrototypeOf(client) as Record<string, unknown>
  for (const name of methods) {
    const own = Object.hasOwn(target, name) ? target[name] : undefined
    if (typeof (own ?? shared[name]) !== "function") continue
    // Looked up on each call, so a spy on the prototype still sees it.
    target[name] = (sql: unknown, ...rest: unknown[]) => {
      const prepare = (own ?? shared[name]) as (...input: unknown[]) => unknown
      const statement = prepare.call(client, sql, ...rest) as Statement
      const writes = typeof sql === "string" ? writeTarget(sql) : undefined
      if (writes) count(statement, writes, tally)
      return statement
    }
  }
  tallies.set(client, tally)
  return client
}

/** The seam built over a counted client shares its counts. */
export const shareCounts = (from: object, to: object): void => {
  const tally = tallies.get(from)
  if (tally) tallies.set(to, tally)
}

export const committedWrites = (database: object): void => {
  const tally = tallies.get(database)
  if (!tally || tally.pending.size === 0) return
  for (const counted of tally.pending.values()) emit(counted)
  tally.pending.clear()
}

export const droppedWrites = (database: object): void => tallies.get(database)?.pending.clear()
