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
const DAMAGED_TEXT = /database disk image is malformed|file is not a database|fts5: corruption/i

/**
 * SQLite's primary result code: node:sqlite's `errcode`, or `errno` only on bun:sqlite's `SQLiteError`. A filesystem
 * error's errno shares the low byte with SQLite's codes: Windows' EIO, -4070, reads as SQLITE_NOTADB.
 */
export const sqliteCode = (error: unknown): number | undefined => {
  const { errcode, errno, name } = (error ?? {}) as { errcode?: unknown; errno?: unknown; name?: unknown }
  const code =
    typeof errcode === "number" ? errcode : name === "SQLiteError" && typeof errno === "number" ? errno : null
  return code === null ? undefined : code & 0xff
}

/** The SQLite failure that says the database file is damaged, on the error or up to five `cause`s behind it. */
const damageIn = (error: unknown): Error | undefined => {
  if (isCliFailure(error) || isCommanderFailure(error)) return undefined
  let at: unknown = error
  for (let depth = 0; depth < 5 && at instanceof Error; depth += 1) {
    const code = sqliteCode(at)
    if ((code !== undefined && [SQLITE_CORRUPT, SQLITE_NOTADB].includes(code)) || DAMAGED_TEXT.test(at.message))
      return at
    at = at.cause
  }
  return undefined
}

// The record's frames are where SQLite failed, not where the failure was renamed.
const wrapping = (error: CliError, original: unknown): CliError => {
  Object.defineProperty(error, "cause", { value: original, configurable: true, writable: true })
  if (original instanceof Error && original.stack) error.stack = original.stack
  return error
}

/**
 * A damaged store file as the owner's problem, not a bug: SQLITE_CORRUPT or SQLITE_NOTADB becomes `store.damaged`.
 * `next` is the command line that says what to do, such as `tg store recover`, only where that command exists.
 * Only for the CLI's own store: a file the owner named goes through `damagedFile`. Any other failure is returned as
 * it came.
 */
export const storeDamaged = (error: unknown, next?: string): unknown =>
  damageIn(error)
    ? wrapping(
        new CliError(
          "configuration_error",
          `the store file is damaged${next ? `; \`${next}\` says what is damaged and what to do` : ""}`,
          { reason: "store.damaged" },
        ),
        error,
      )
    : error

/** Runs `work` on store files the owner named, so a damaged one is named rather than taken for the CLI's own. */
export const damagedFile = async <T>(files: readonly string[], work: () => Promise<T>): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    if (!damageIn(error)) throw error
    throw wrapping(
      new CliError("validation_error", `${files.join(" or ")} is damaged or not a database`, {
        reason: "store.file-damaged",
      }),
      error,
    )
  }
}

/** Whether `error` is SQLite saying the database file is damaged. */
export const isStoreDamage = (error: unknown): boolean => damageIn(error) !== undefined
