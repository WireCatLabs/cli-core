import { type CliError, errorCodes } from "@wirecat/cli-base"

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

/** What failed, never what it said: a messenger's refusal can quote the message back. */
export const failureKey = (error: unknown): string =>
  isCliFailure(error) ? error.code : error instanceof Error ? error.name : "error"
