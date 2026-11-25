import type { Command, Option } from "commander"

/**
 * The commander fields with no public accessor that the command skeleton relies on. They are read here only, so a
 * commander release that renames one fails `commander-internals.test.ts` rather than a CLI at run time. Not exported
 * from any entry point.
 */
interface Internals {
  _actionHandler?: unknown
  _hidden?: boolean
  _getHelpOption(): HelpOption | null
  unknownOption(flag: string): never
}

/** `is` matches the long or short flag, as commander checks it. */
type HelpOption = Option & { is(word: string): boolean }

const internals = (command: Command): Internals => command as unknown as Internals

/** Whether the command runs an action of its own, rather than only grouping others. */
export const hasOwnAction = (command: Command): boolean => internals(command)._actionHandler != null

export const isHidden = (command: Command): boolean => internals(command)._hidden === true

/** Hides a command already added, as `{ hidden: true }` does when it is added. */
export const hide = (command: Command): void => {
  internals(command)._hidden = true
}

export const helpOptionOf = (command: Command): HelpOption | null => internals(command)._getHelpOption()

/** Fails as commander does for an option the command does not take. */
export const rejectUnknownOption = (command: Command, flag: string): never => internals(command).unknownOption(flag)

/** Replaces commander's failure for an unknown option; `fallback` is commander's own. */
export const onUnknownOption = (
  command: Command,
  handle: (flag: string, fallback: (flag: string) => never) => never,
) => {
  const own = internals(command)
  const fallback = own.unknownOption.bind(command)
  own.unknownOption = (flag) => handle(flag, fallback)
}
