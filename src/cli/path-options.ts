import { dirname, isAbsolute, join, resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import type { Argument, Command, Option } from "commander"
import type { AppIdentity } from "../ports/app.js"
import { inside, realPathOf, refusedPlace } from "../sends/upload.js"
import { storePath } from "../store/path.js"

const PATH_NAME = /^([a-z]+-)*(file|path|dir|directory|folder)s?$/
const PATH_PLACEHOLDER = /[<[]([a-z]+-)*(file|path|dir|directory|folder)s?(\.\.\.)?[>\]]/

const NOT_LOCAL = new WeakMap<Command, Set<string>>()
const IN_BACKUPS = new WeakMap<Command, Set<string>>()

const mark = <T extends Command>(marks: WeakMap<Command, Set<string>>, command: T, names: string[]): T => {
  marks.set(command, new Set([...(marks.get(command) ?? []), ...names]))
  return command
}

/**
 * Inputs of `command`, and of the commands under it, whose name or placeholder reads like a path but that name no file
 * here: a path on the remote side, a chat folder's title, a command path. By an argument's name or an option's
 * attribute name (`outputDir`).
 */
export const notLocalPaths = <T extends Command>(command: T, ...names: string[]): T => mark(NOT_LOCAL, command, names)

/** Local paths of `command` that may also name the store's own backups folder, inside the WireCat folder. */
export const inStoreBackups = <T extends Command>(command: T, ...names: string[]): T => mark(IN_BACKUPS, command, names)

/** A mark on a group holds for every command under it. */
const marked = (marks: WeakMap<Command, Set<string>>, command: Command, name: string): boolean => {
  for (let at: Command | null = command; at; at = at.parent) if (marks.get(at)?.has(name)) return true
  return false
}

/** An option whose value is a file or folder on this machine: its placeholder says so, and nothing marked it not. */
export const isLocalPathOption = (command: Command, option: Option): boolean =>
  PATH_PLACEHOLDER.test(option.flags) && !marked(NOT_LOCAL, command, option.attributeName())

export const isLocalPathArgument = (command: Command, argument: Argument): boolean =>
  PATH_NAME.test(argument.name()) && !marked(NOT_LOCAL, command, argument.name())

/** An option or argument named like a path, which `isLocalPath…` must take or `notLocalPaths` must name. */
export const looksLikePath = (name: string): boolean =>
  /(^|-)(file|path|dir|directory|folder)s?$/.test(name) || /^output(-|$)/.test(name)

export const isNotLocalPath = (command: Command, name: string): boolean => marked(NOT_LOCAL, command, name)

const isNamed = (value: string) => value !== "" && value !== "-" && !value.includes("://")

const valuesOf = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((one): one is string => typeof one === "string" && isNamed(one))

export interface LocalPathInput {
  /** As help shows it: `--output-dir` or `<file>`. */
  flag: string
  value: string
  inBackups: boolean
}

/**
 * Every file or folder on this machine the run was given, as the command's options (its parents' too) and arguments
 * hold them. Only what the caller named: a default, an environment variable or a config value the owner set is left
 * out.
 */
export const localPathsOf = (action: Command): LocalPathInput[] => {
  const found: LocalPathInput[] = []
  for (let at: Command | null = action; at; at = at.parent) {
    for (const option of at.options) {
      const key = option.attributeName()
      if (!isLocalPathOption(at, option) || at.getOptionValueSource(key) !== "cli") continue
      const flag = option.long ?? option.flags
      for (const value of valuesOf(at.getOptionValue(key)))
        found.push({ flag, value, inBackups: marked(IN_BACKUPS, at, key) })
    }
  }
  action.registeredArguments.forEach((argument, index) => {
    const value = action.processedArgs[index]
    if (!isLocalPathArgument(action, argument) || value === argument.defaultValue) return
    for (const one of valuesOf(value))
      found.push({ flag: `<${argument.name()}>`, value: one, inBackups: marked(IN_BACKUPS, action, argument.name()) })
  })
  return found
}

/**
 * Refuses an MCP agent's call that names a credential folder, a folder of this or another WireCat tool, or the store
 * (`refusedPlace`), by its real path, so neither a link nor `..` gets past. The owner's own shell runs are not
 * checked here; the commands that guard a path for them still do.
 */
export const refuseAgentPaths = (action: Command, app: AppIdentity, env: NodeJS.ProcessEnv): void => {
  const backups = join(dirname(resolve(storePath(env))), "backups")
  for (const { flag, value, inBackups } of localPathsOf(action)) {
    if (inBackups && inside(realPathOf(value), realPathOf(backups))) continue
    if (refusedPlace(value, app, env))
      throw new CliError(
        "permission_error",
        `${flag} ${value}: an agent's call reads and writes no credential folder, no folder of a WireCat tool and ` +
          "not the message store — the owner runs it in a terminal",
        { param: flag, sent: false },
      )
  }
}

/** A path made absolute against `cwd`, the client's working folder, for a command serve runs for it. */
export const absoluteFrom = (cwd: string, value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((one) => absoluteFrom(cwd, one))
  if (typeof value !== "string" || !isNamed(value) || isAbsolute(value)) return value
  return resolve(cwd, value)
}
