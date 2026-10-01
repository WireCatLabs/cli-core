/**
 * The command registry: the whole command tree of a CLI as data, however each command came to be.
 *
 * It walks the live Commander tree rather than a list written by hand, so a command built in a
 * loop from a catalog shows up exactly like one written in a file. What the tree cannot say — where
 * a command came from, whether it changes anything, whether it is on its way out — is attached with
 * `annotate`.
 *
 * Behind its own entry point for the same reason `/http` is: Commander is only a type here, and the
 * root of this package stays free of any command-line framework.
 */
import type { Argument, Command, Option } from "commander"

export type Origin = "handwritten" | "generated"
export type CommandState = "beta" | "deprecated"

export interface CommandMeta {
  origin?: Origin
  /** The catalog operation a generated command was made from. */
  operationId?: string
  /** True when running the command changes something: a write, wherever it lands. */
  mutates?: boolean
  /** With `mutates`: what it changes is only on this machine — a file, the keyring — never the service. */
  local?: boolean
  state?: CommandState
  examples?: readonly string[]
}

export interface ArgumentInfo {
  name: string
  required: boolean
  variadic: boolean
  description: string
  choices?: readonly string[]
  default?: unknown
}

export interface OptionInfo {
  flags: string
  description: string
  /** False for a plain switch like `--json`, so an agent knows not to look for a value. */
  takesValue: boolean
  /**
   * Whether the option itself must be given. Deliberately not Commander's `required`, which means
   * "takes a value when present" — reading that as "you must pass this" is the obvious misreading.
   */
  mandatory: boolean
  choices?: readonly string[]
  default?: unknown
  env?: string
  /** Options that may not be given together with this one. */
  conflicts?: readonly string[]
  /** Values this option sets on others when they are not given. */
  implies?: Readonly<Record<string, unknown>>
}

export interface CommandInfo {
  /** What to pass to the CLI, already split: `["runs", "list"]`. */
  path: readonly string[]
  name: string
  summary?: string
  description: string
  usage: string
  origin: Origin
  operationId?: string
  mutates?: boolean
  local?: boolean
  state?: CommandState
  examples?: readonly string[]
  arguments: readonly ArgumentInfo[]
  options: readonly OptionInfo[]
  commands: readonly CommandInfo[]
}

const labels = new WeakMap<Command, CommandMeta>()

/** Attaches what the tree cannot say. Repeated calls merge; the command is returned for chaining. */
export const annotate = <T extends Command>(command: T, meta: CommandMeta): T => {
  labels.set(command, { ...labels.get(command), ...meta })
  return command
}

export const metaOf = (command: Command): CommandMeta => labels.get(command) ?? {}

export const describeProgram = (root: Command): CommandInfo[] =>
  visible(root).map((child) => describe(child, root.name(), []))

export const describeOptions = (command: Command): OptionInfo[] =>
  command.options.filter((option) => !option.hidden).map(describeOption)

export const flatten = (commands: readonly CommandInfo[]): CommandInfo[] =>
  commands.flatMap((command) => [command, ...flatten(command.commands)])

const describe = (command: Command, cli: string, parents: readonly string[]): CommandInfo => {
  const path = [...parents, command.name()]
  const args = command.registeredArguments.map(describeArgument)
  const options = describeOptions(command)
  const { origin = "handwritten", ...meta } = metaOf(command)

  const usage = [
    cli,
    ...path,
    ...args.map((argument) => (argument.required ? `<${argument.name}>` : `[${argument.name}]`)),
    options.length > 0 ? "[options]" : "",
  ]
    .filter(Boolean)
    .join(" ")

  return {
    path,
    name: command.name(),
    ...(command.summary() ? { summary: command.summary() } : {}),
    description: command.description(),
    usage,
    origin,
    ...meta,
    arguments: args,
    options,
    commands: visible(command).map((child) => describe(child, cli, path)),
  }
}

// `addCommand(command, { hidden: true })` sets only this; Commander has no public getter for it.
const visible = (command: Command): Command[] =>
  command.commands.filter((child) => !(child as Command & { _hidden?: boolean })._hidden)

const describeArgument = (argument: Argument): ArgumentInfo => ({
  name: argument.name(),
  required: argument.required,
  variadic: argument.variadic,
  description: argument.description,
  ...(argument.argChoices ? { choices: argument.argChoices } : {}),
  ...(argument.defaultValue === undefined ? {} : { default: argument.defaultValue }),
})

// Commander 15 keeps these on every option but leaves them out of its type declarations.
type Related = { conflictsWith?: string[]; implied?: Record<string, unknown> }

const describeOption = (option: Option): OptionInfo => {
  const { conflictsWith = [], implied } = option as Option & Related
  return {
    flags: option.flags,
    description: option.description,
    takesValue: option.required || option.optional,
    mandatory: option.mandatory,
    ...(option.argChoices ? { choices: option.argChoices } : {}),
    ...(option.defaultValue === undefined ? {} : { default: option.defaultValue }),
    ...(option.envVar ? { env: option.envVar } : {}),
    ...(conflictsWith.length > 0 ? { conflicts: conflictsWith } : {}),
    ...(implied ? { implies: implied } : {}),
  }
}

export {
  COMMANDS_PAGE_LABELS,
  type CommandsPage,
  type CommandsPageLabels,
  type CommandsPageText,
  commandsPage,
} from "./page.js"
