const SQLITE_WARNING = "SQLite is an experimental feature"

const quieted = new WeakSet<object>()

/**
 * Node 22 prints `ExperimentalWarning: SQLite is an experimental feature` when `node:sqlite` first loads; Node 24 does
 * not. Agents read the two stderr lines as a failure (`NEED-1448`), so this drops that one warning and passes every
 * other one through. It must run before `node:sqlite` loads, and a builtin loads while its importer is linked —
 * before any statement of that importer runs — so callers call it before the dynamic import, never beside a static one.
 */
export const quietSqliteWarning = (host: Pick<NodeJS.Process, "emitWarning"> = process): void => {
  if (quieted.has(host)) return
  quieted.add(host)
  const emit = host.emitWarning
  host.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    if (isSqliteWarning(warning, rest[0])) return
    return Reflect.apply(emit, this, [warning, ...rest])
  } as NodeJS.Process["emitWarning"]
}

const isSqliteWarning = (warning: string | Error, options: unknown): boolean => {
  const type = typeof options === "string" ? options : (options as { type?: string } | undefined)?.type
  const name = typeof warning === "string" ? type : warning.name
  const message = typeof warning === "string" ? warning : warning.message
  return name === "ExperimentalWarning" && message.startsWith(SQLITE_WARNING)
}
