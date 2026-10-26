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

export const isProfileName = (word: string): boolean => PLAIN_NAME.test(word)

export const usableProfileName = (profile: string): string => {
  if (!isProfileName(profile)) {
    throw new CliError(
      "validation_error",
      `"${profile}" cannot be a profile name — letters, digits, dot, dash and underscore only, ` +
        "starting with a letter or a digit",
    )
  }
  return profile
}

/** The top-level commands that never read a profile; every other one is `<tool> <profile> …`. */
export const PROFILE_FREE: ReadonlySet<string> = new Set(["commands", "complete", "guide", "help", "skill", "upgrade"])

const freeOfProfile = new WeakSet<Command>()

/**
 * Marks a command, and every command under it, as one that reads no profile, so help shows it without one:
 * `drive doctor`, not `drive personal doctor`. Which commands those are is the CLI's to say.
 */
export const profileFree = <T extends Command>(command: T): T => {
  freeOfProfile.add(command)
  return command
}

/** Whether the command line puts a profile before this command: not for `PROFILE_FREE` or a `profileFree` one. */
export const takesProfile = (command: Command): boolean => {
  let top: Command | undefined
  for (let at: Command | null = command; at?.parent; at = at.parent) {
    if (freeOfProfile.has(at)) return false
    top = at
  }
  return top !== undefined && !PROFILE_FREE.has(top.name())
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
export const liftProfile = (
  argv: string[],
  words: Set<string>,
  valued: ReadonlySet<string> = new Set(),
): { profile?: string; rest: string[] } => {
  // `tg --json personal chats list`: options before the profile are skipped over, with the value an option takes.
  let at = 0
  while (argv[at]?.startsWith("-") && argv[at] !== "--") at += valued.has(argv[at] as string) ? 2 : 1
  const first = argv[at]
  if (first === undefined || first.startsWith("-") || words.has(first)) return { rest: argv }
  return { profile: first, rest: [...argv.slice(0, at), ...argv.slice(at + 1)] }
}

/** The root's options that take the next word as their value: `--timeout 30s`. */
export const valuedOptions = (program: Command): Set<string> =>
  new Set(
    program.options
      .filter((option) => option.required)
      .flatMap((option) => [option.long, option.short].filter((flag): flag is string => flag !== undefined)),
  )

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

/**
 * A command this CLI really has, for an example: the first path down to a leaf that takes a profile,
 * skipping `PROFILE_FREE` and `profileFree` ones. Works on commands not yet added to the program.
 */
export const sampleCommand = (commands: readonly Command[]): string | undefined => {
  const pathFrom = (command: Command): string[] | undefined => {
    if (freeOfProfile.has(command)) return undefined
    const children = command.commands.filter((one) => one.name() !== "help")
    if (children.length === 0) return [command.name()]
    for (const child of children) {
      const rest = pathFrom(child)
      if (rest) return [command.name(), ...rest]
    }
    return undefined
  }
  for (const command of commands) {
    const path = PROFILE_FREE.has(command.name()) ? undefined : pathFrom(command)
    if (path) return path.join(" ")
  }
  return undefined
}
