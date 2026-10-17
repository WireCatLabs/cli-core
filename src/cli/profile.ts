import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"

/** How the command line names this profile: always the first word, since none is assumed. */
export const asFirstWord = (profile: string): string => `${profile} `

/**
 * A profile name becomes a file name and a keyring account, and the first word on the command line
 * is the profile — so a mistyped path arrives here as a name, and `a/../b` would write a file
 * somewhere nobody would think to look.
 */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const usableProfileName = (profile: string): string => {
  if (!PLAIN_NAME.test(profile)) {
    throw new CliError(
      "validation_error",
      `"${profile}" cannot be a profile name — letters, digits, dot, dash and underscore only, ` +
        "starting with a letter or a digit",
    )
  }
  return profile
}

/**
 * Every word that means a command at the top level. Taken off the built program rather than
 * written out, because a list written out goes stale the day a command is added — and `help` is in
 * it without being in `program.commands`.
 */
export const commandWords = (program: Command): Set<string> =>
  new Set(["help", ...program.commands.flatMap((command) => [command.name(), ...command.aliases()])])

/**
 * **The first word is the profile unless it names a command.** `tg personal chats list`, and
 * `TG_PROFILE=personal tg chats list`, with no flag in either. An option is never a profile, so
 * `tg --json chats list` still works.
 */
export const liftProfile = (argv: string[], words: Set<string>): { profile?: string; rest: string[] } => {
  const [first, ...rest] = argv
  if (first === undefined || first.startsWith("-") || words.has(first)) return { rest: argv }
  return { profile: first, rest }
}

/**
 * Refused at creation, which is the only moment it can still be explained: a profile named after a
 * command could never be selected, because `tg chats` has to mean the command.
 */
export const refuseCommandName = (profile: string, words: Set<string>, command: string): void => {
  if (words.has(profile)) {
    throw new CliError(
      "validation_error",
      `"${profile}" is a command, so \`${command} ${profile} …\` would always mean the command and never ` +
        "this profile. Pick a name that is not one of: " +
        [...words].sort().join(", "),
    )
  }
}

/** The root of the command tree, from anywhere inside it. */
export const rootOf = (command: Command): Command => {
  let root = command
  while (root.parent) root = root.parent
  return root
}
