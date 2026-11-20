type Statement = Record<"run" | "all" | "get", (...parameters: unknown[]) => unknown>

/** A statement's shape without its values: a query may hold the owner's words, so only the shape is printed. */
export const queryShape = (sql: string): string =>
  sql
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400)

const rowsOf = (result: unknown) =>
  Array.isArray(result)
    ? result.length
    : result && typeof result === "object" && "changes" in result
      ? Number(result.changes)
      : result === undefined || result === null
        ? 0
        : 1

/**
 * With `WIRECAT_SQL_SLOW_MS` set, every statement slower than that many milliseconds prints its time, rows and shape
 * to stderr. A cold search once read 1.5 GB through one query that looked cheap on an empty store; this names it.
 */
export const timeQueries = <C extends object>(client: C, methods: readonly string[]): C => {
  const threshold = Number(process.env.WIRECAT_SQL_SLOW_MS)
  if (!process.env.WIRECAT_SQL_SLOW_MS || !Number.isFinite(threshold)) return client
  const target = client as Record<string, unknown>
  for (const name of methods) {
    const prepare = target[name]
    if (typeof prepare !== "function") continue
    target[name] = (sql: unknown, ...rest: unknown[]) => {
      const statement = prepare.call(client, sql, ...rest) as Statement
      if (typeof sql !== "string") return statement
      for (const method of ["run", "all", "get"] as const) {
        const original = statement[method]
        statement[method] = (...parameters) => {
          const started = performance.now()
          const result = original.apply(statement, parameters)
          const took = performance.now() - started
          if (took >= threshold)
            process.stderr.write(`sql ${took.toFixed(0)} ms, ${rowsOf(result)} rows: ${queryShape(sql)}\n`)
          return result
        }
      }
      return statement
    }
  }
  return client
}
