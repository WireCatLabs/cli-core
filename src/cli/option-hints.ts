import type { Command } from "commander"

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
export const START_FLAGS = ["--since", "--after", "--from", "--since-date", "--after-date", "--start"]
export const END_FLAGS = ["--until", "--before", "--to", "--until-date", "--before-date", "--end"]

export const AROUND_HINT =
  "read the messages either side of one: messages context <hit ref> --before-n 5 --after-n 5 " +
  "(or messages context <chat> <message>)"
