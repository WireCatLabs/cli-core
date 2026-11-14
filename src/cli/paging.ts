import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { environmentOf, withAgentLevels } from "./context.js"
import { DEFAULT_CONFIG } from "./default-config.js"
import type { GlobalFlags, Settings } from "./settings.js"

/**
 * The three flags every listing shares, so no command invents its own spelling of them.
 *
 * ⚠ **None of them gets a `default`.** With one, commander reports the flag as always given and a
 * configured `limit` could never win it; the number lives once, in `resolveSettings`.
 */
/** Refused as typed: by the time a number reaches the settings, `abc` is `NaN` and `12abc` is `12`. */
export const positiveCount =
  (flag: string) =>
  (value: string): number => {
    if (!/^\d+$/.test(value.trim()) || Number(value) < 1)
      throw new CliError("validation_error", `${flag} takes a whole number from 1 upwards, not "${value}"`)
    return Number(value)
  }

/**
 * The configured `limit`, for a command with no messenger context to read it from, such as `runs list`. A command
 * whose own maximum is lower caps it there: a configured `limit: 200` is a listing's page, not a refused flag.
 */
export const configuredLimit = (command: Command, most = Number.POSITIVE_INFINITY): number => {
  const { resolveSettings, env } = environmentOf(command)
  const { limit: _typed, ...flags } = command.optsWithGlobals<GlobalFlags>()
  const configured =
    resolveSettings?.(flags, { needsProfile: false, ...(env ? { env } : {}) }).limit ?? DEFAULT_CONFIG.defaults.limit
  return Math.min(configured, most)
}

export const withPaging = (command: Command): Command =>
  command
    .option("--limit <n>", "how many to show", positiveCount("--limit"))
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"))
    .option("--all", "every row, no paging")

/**
 * Which rows to ask the store for. `--all` means no limit, which the store reads as "everything".
 *
 * ⚠ **A page number over a live list can repeat or skip a row.** The order is most-recent-first,
 * so a message arriving between page one and page two pushes somebody across the boundary. Every
 * CLI that pages this way has this; it is in `--help` rather than engineered away.
 */
export const window = ({ limit, page, all }: Settings): { limit?: number; offset: number } =>
  all ? { offset: 0 } : { limit, offset: (page - 1) * limit }

/**
 * `--limit` and `--page` of a command outside a messenger's context (`meetings list`, `events list`): the flag, else
 * the profile's `defaults.limit`, as the shared listings resolve it. Outside `run()`, the shipped default.
 */
export const pagingOf = (command: Command): Pick<Settings, "limit" | "page"> => {
  const environment = environmentOf(command)
  const flags = command.optsWithGlobals<{ limit?: number; page?: number }>()
  if (!environment.resolveSettings)
    return { limit: flags.limit ?? DEFAULT_CONFIG.defaults.limit, page: flags.page ?? 1 }
  const { limit, page } = environment.resolveSettings(withAgentLevels(command, command.optsWithGlobals()), {
    env: environment.env ?? process.env,
    needsProfile: false,
    readOnly: true,
  })
  // A host's settings are force-cast to `Settings`; one that leaves these out must still page, not offset by NaN.
  return { limit: limit ?? DEFAULT_CONFIG.defaults.limit, page: page ?? 1 }
}
