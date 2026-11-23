import { CliError, isCliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { commandPathOf } from "./command-contract.js"

/**
 * A flag a command does not take, but an agent is likely to type, fails with what to type instead rather than
 * commander's bare "unknown option".
 */
export const withOptionHints = (command: Command, hints: Readonly<Record<string, string>>): Command => {
  const unknown = command as unknown as { unknownOption: (flag: string) => never }
  const fallback = unknown.unknownOption.bind(command)
  unknown.unknownOption = (flag) => {
    const hint = hints[flag.split("=")[0] as string]
    if (hint === undefined) return fallback(flag)
    return command.error(`unknown option '${flag}' — ${hint}`, { code: "commander.unknownOption" })
  }
  return command
}

/** The same hint for each of these flags. */
export const hintsFor = (flags: readonly string[], hint: string): Record<string, string> =>
  Object.fromEntries(flags.map((flag) => [flag, hint]))

/** Date flags agents guess; commander would suggest an unrelated near name (`--since` → `--source`). */
export const START_FLAGS = ["--since", "--after", "--since-date", "--after-date", "--start"]
export const END_FLAGS = ["--until", "--before", "--until-date", "--before-date", "--end"]

/** In a message search `--from` means the sender, as `from:` does in the query, never a date. */
export const SENDER_FLAGS = ["--from", "--sender", "--author"]

export const AROUND_HINT =
  "read the messages either side of one: messages context <hit ref> --before-n 5 --after-n 5 " +
  "(or messages context <chat> <message>)"

/** A flag of a sibling command: the agent picked the wrong command, and a near flag of this one would mislead. */
export const siblingOption = (leaf: Command | undefined, message: string): string => {
  const flag = /^unknown option '([^'=]+)/.exec(message)?.[1]
  if (!flag || !leaf?.parent || / — |\(Did you mean/.test(message)) return ""
  const owners = leaf.parent.commands.filter(
    (one) => one !== leaf && one.options.some((option) => option.long === flag),
  )
  if (owners.length === 0) return ""
  return ` — ${flag} is an option of ${owners.map((one) => commandPathOf(one).join(" ")).join(", ")}`
}

/**
 * Every word after `--` is an argument, so an option left there, one the command does not take, silently became
 * query text and fails as syntax far from its cause.
 */
export const queryAfterDashes = (error: unknown, leaf: Command | undefined, argv: readonly string[]): unknown => {
  if (!isCliError(error) || !String(error.details.reason ?? "").startsWith("query.") || !argv.includes("--"))
    return error
  const query = leaf?.processedArgs.at(-1)
  if (!Array.isArray(query) || query.length === 0) return error
  return new CliError(
    error.code,
    `${error.message} — after --, every word is an argument, so "${query.join(" ")}" was read as the query; ` +
      "put options before --",
    error.details,
  )
}
