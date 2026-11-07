import { CliError, errorCodes } from "@wirecat/cli-base"

/**
 * **By shape, not by class.** A package linked during development brings its own copy of
 * cli-base, and an error built with one copy is not an `instanceof` the other's `CliError` —
 * measured 2026-09-27: an ambiguous chat name from `pickChat` reached tg-cli's `run` as an unknown
 * failure, exit 1, and lost its list of candidates. A name and a code from the closed list
 * identify one in every install layout.
 */
export const isCliFailure = (value: unknown): value is CliError =>
  value instanceof Error &&
  value.name === "CliError" &&
  (errorCodes as readonly string[]).includes((value as { code?: unknown }).code as string)

/** Commander's own errors, by the same rule: its `code` always starts with `commander.`. */
export const isCommanderFailure = (value: unknown): value is Error & { code: string; exitCode: number } => {
  const { code, exitCode } = (value ?? {}) as { code?: unknown; exitCode?: unknown }
  return (
    value instanceof Error && typeof code === "string" && code.startsWith("commander.") && typeof exitCode === "number"
  )
}

/** What failed, never what it said: a messenger's refusal can quote the message back. */
export const failureKey = (error: unknown): string =>
  isCliFailure(error) ? error.code : error instanceof Error ? error.name : "error"

const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26
const DAMAGED_TEXT = /database disk image is malformed|file is not a database/i

const isDamageError = (error: unknown): boolean => {
  const { errcode, errno, message } = (error ?? {}) as { errcode?: unknown; errno?: unknown; message?: unknown }
  const code = errcode ?? errno
  if (typeof code === "number" && [SQLITE_CORRUPT, SQLITE_NOTADB].includes(code & 0xff)) return true
  return typeof message === "string" && DAMAGED_TEXT.test(message)
}

/**
 * A damaged store file as the owner's problem, not a bug: SQLITE_CORRUPT or SQLITE_NOTADB from any query, or behind a
 * wrapper's `cause`, becomes `store.damaged` with `store recover` as its next step. Any other failure is returned as
 * it came.
 */
export const storeDamaged = (error: unknown, command?: string): unknown => {
  if (isCliFailure(error) || isCommanderFailure(error)) return error
  let at: unknown = error
  for (let depth = 0; depth < 5 && at !== undefined && at !== null; depth += 1) {
    if (isDamageError(at)) {
      const recover = command ? `\`${command} store recover\`` : "`store recover`"
      return new CliError(
        "configuration_error",
        `the store file is damaged; ${recover} says what is lost and how to recover it`,
        { reason: "store.damaged", cause: error },
      )
    }
    at = (at as { cause?: unknown }).cause
  }
  return error
}
