export { failureKey, isCliFailure } from "../domain/errors.js"

/** Commander's own errors, by the same rule: its `code` always starts with `commander.`. */
export const isCommanderFailure = (value: unknown): value is Error & { code: string; exitCode: number } => {
  const { code, exitCode } = (value ?? {}) as { code?: unknown; exitCode?: unknown }
  return (
    value instanceof Error && typeof code === "string" && code.startsWith("commander.") && typeof exitCode === "number"
  )
}
