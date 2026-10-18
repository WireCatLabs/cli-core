import { Readable } from "node:stream"
import { CliError, captureStreams, errorObjectOf } from "@wirecat/cli-base"
import {
  type ArgumentInfo,
  type CommandInfo,
  type CommandOutput,
  flatten,
  type OptionInfo,
} from "@wirecat/cli-base/commands"
import { type ErrorObject, writes } from "@wirecat/cli-base/standards"
import { VOCABULARY } from "@wirecat/cli-base/standards/tables"
import * as v from "valibot"
import { lentConnection } from "../cli/messenger/serve-relay.js"
import type { RunOptions } from "../cli/program.js"
import type { StdinField } from "../cli/stdin-field.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import { keyForCommand, type Level, levelFor, type PermissionKey, readKeysForCommand } from "../sends/permissions.js"

/** The CLI's own `run` — a fresh program on every call — and its command tree as `commands --json` describes it. */
export interface AgentProgram {
  run: (argv: string[], environment: RunOptions) => Promise<number>
  commands: readonly CommandInfo[]
}

export interface AgentContext {
  profile: string
  env?: NodeJS.ProcessEnv
  /** The levels in force now, this server's stricter ones included; read on every call. */
  levels?: () => Readonly<Record<PermissionKey, Level>>
  /** This server's own stricter levels, `key=level`, which the command's guard applies too. */
  overrides?: readonly string[]
  /** The key a CLI's own command is checked against, when `keyForCommand` does not know it. */
  keyOf?: (path: readonly string[]) => PermissionKey | null | undefined
  /** The server's one open connection. The command borrows it: it cannot close it, and never opens its own. */
  connection?: () => Promise<MessengerAdapter>
  /** What a command reads on stdin, as the field an agent gives it in. */
  stdin?: (path: readonly string[]) => StdinField | undefined
  /** More of the run's environment, read by the commands that look for it: the server's `spawnJob`, `embedders`. */
  environment?: Readonly<Record<string, unknown>>
}

export type AgentAnswer = { result: unknown } | { error: ErrorObject }

/** One command an agent may run: its path under the server's root, and its arguments as a schema. */
export interface AgentTool {
  command: string
  /** From the program's root: `["bot", "messages", "send"]`. */
  path: readonly string[]
  title: string
  description: string
  writes: boolean
  input: v.ObjectSchema<v.ObjectEntries, undefined>
  /** The entity it answers with, when the command declares one. */
  output?: CommandOutput
}

export interface CatalogueOptions {
  /** The subtree a server is built from: `["bot"]` for the bot server. */
  root?: readonly string[]
  /** Subtrees under the root left out: the personal server leaves out `["bot"]`. */
  exclude?: readonly (readonly string[])[]
  /** The profile's levels when the server starts: what they refuse is not offered. */
  levels?: Readonly<Record<PermissionKey, Level>>
  keyOf?: (path: readonly string[]) => PermissionKey | null | undefined
  /** Arguments left out of every tool, by name. */
  omit?: readonly string[]
  /** Offer `offline` on commands that read the messenger: answer from the copy on this machine. */
  offline?: boolean
  /** What a command reads on stdin, as the field an agent gives it in. */
  stdin?: (path: readonly string[]) => StdinField | undefined
}

const TYPES = new Map(VOCABULARY.flags.map((flag) => [flag.name, flag.type]))

// `<name|id>` is one argument: its field is `name_or_id`.
const snake = (name: string) => name.replaceAll("|", "_or_").replace(/[^a-z0-9]+/gi, "_")

const longOf = (option: OptionInfo): string | undefined => option.flags.match(/--[a-z0-9][a-z0-9-]*/)?.[0]

const text = (description: string) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    // `-` alone reads stdin, which is the MCP transport.
    v.regex(/^(?!-$)[\s\S]+$/, "a value, and not only -"),
    v.description(description),
  )

type ValueKind = "switch" | "count" | "number" | "list" | "variadic" | "json" | "text"

interface Field {
  name: string
  required: boolean
  schema: v.GenericSchema
  argv: (value: unknown) => string[]
  positional: boolean
  /** Given to the command on stdin, not as an argument. */
  stdin?: true
}

const optionKind = (option: OptionInfo, long: string): ValueKind => {
  if (!option.takes_value) return "switch"
  if (option.choices) return "text"
  const type = TYPES.get(long)
  if (type === "count" || type === "number" || type === "list") return type
  if (/<json>/.test(option.flags)) return "json"
  return /\.\.\.[>\]]/.test(option.flags) ? "variadic" : "text"
}

const optionField = (option: OptionInfo, long: string, negatable = false): Field => {
  const kind = optionKind(option, long)
  const about = option.description
  const schema =
    kind === "switch"
      ? v.pipe(v.boolean(), v.description(about))
      : option.choices
        ? v.pipe(v.picklist(option.choices as string[]), v.description(about))
        : kind === "count"
          ? // The command judges the range: `--thread-hops 0` is one, `--limit 0` is not.
            v.pipe(v.number(), v.integer(), v.minValue(0), v.description(about))
          : kind === "number"
            ? v.pipe(v.number(), v.description(about))
            : kind === "list"
              ? // The command line takes `a,b`; an agent may write it so, or as a list.
                v.pipe(v.union([v.pipe(v.array(text("one value")), v.minLength(1)), text(about)]), v.description(about))
              : kind === "variadic"
                ? v.pipe(v.array(text("one value")), v.minLength(1), v.description(about))
                : kind === "json"
                  ? // A next step hands back the object an answer gave; the command takes it as JSON text.
                    v.pipe(v.union([v.string(), v.record(v.string(), v.unknown())]), v.description(about))
                  : text(about)
  return {
    name: snake(long.slice(2)),
    required: option.mandatory,
    schema,
    positional: false,
    argv: (value) => {
      // `approval: false` where the command has `--no-approval` says so; elsewhere false is leaving the switch off.
      if (kind === "switch") return value === true ? [long] : negatable ? [`--no-${long.slice(2)}`] : []
      if (kind === "variadic") return (value as unknown[]).map((one) => `${long}=${String(one)}`)
      if (kind === "list") return [`${long}=${Array.isArray(value) ? value.map(String).join(",") : String(value)}`]
      if (kind === "json") return [`${long}=${typeof value === "string" ? value : JSON.stringify(value)}`]
      return [`${long}=${String(value)}`]
    },
  }
}

const argumentField = (argument: ArgumentInfo): Field => {
  const one = argument.choices
    ? v.pipe(v.picklist(argument.choices as string[]), v.description(argument.description))
    : text(argument.description || argument.name)
  return {
    name: snake(argument.name),
    required: argument.required,
    // A query is several words on the command line; an agent writes it as one string, which is one of them.
    schema: argument.variadic ? v.union([v.pipe(v.array(one), v.minLength(argument.required ? 1 : 0)), one]) : one,
    positional: true,
    argv: (value) => (Array.isArray(value) ? value.map(String) : [String(value)]),
  }
}

const OFFLINE: Field = {
  name: "offline",
  required: false,
  schema: v.pipe(v.boolean(), v.description("answer from the copy on this machine only")),
  positional: false,
  argv: (value) => (value === true ? ["--offline"] : []),
}

const stdinField = ({ name, description, json }: StdinField): Field => ({
  name,
  required: true,
  schema: json
    ? v.pipe(v.union([v.string(), v.record(v.string(), v.unknown())]), v.description(description))
    : v.pipe(v.string(), v.minLength(1), v.description(description)),
  positional: false,
  stdin: true,
  argv: () => [],
})

const fieldsOf = (
  info: CommandInfo,
  { omit = [], offline = false, stdin }: Pick<CatalogueOptions, "omit" | "offline" | "stdin">,
) => {
  const fields: Field[] = info.arguments.map(argumentField)
  const read = stdin?.(info.path)
  if (read) fields.push(stdinField(read))
  const longs = new Set(info.options.map(longOf))
  for (const option of info.options) {
    const long = longOf(option)
    if (!long || option.mcp === false) continue
    fields.push(optionField(option, long, longs.has(`--no-${long.slice(2)}`)))
  }
  if (offline && info.effects?.remote === "read" && info.offline !== false) fields.push(OFFLINE)
  return fields.filter((field) => !omit.includes(field.name))
}

const schemaOf = (fields: readonly Field[]) =>
  v.object(
    Object.fromEntries(fields.map((field) => [field.name, field.required ? field.schema : v.optional(field.schema)])),
  )

const startsWith = (path: readonly string[], prefix: readonly string[]) => prefix.every((word, at) => path[at] === word)

/** Why the profile refuses this command now, or nothing. */
const refusal = (
  info: CommandInfo,
  levels: Readonly<Record<PermissionKey, Level>>,
  keyOf: CatalogueOptions["keyOf"],
): string | undefined => {
  const key = keyOf?.(info.path) ?? keyForCommand(info.path)
  const level = key ? levelFor(levels, key).level : "allow"
  if (level === "deny") return `the profile denies ${key}`
  if (level === "readonly" && writes(info.effects)) return `${key} is readonly in this profile`
  const denied = readKeysForCommand(info.path).find((read) => levelFor(levels, read).level === "deny")
  return denied ? `the profile denies ${denied}` : undefined
}

/**
 * One tool per command an agent may run under `root` (NEED-1411): every leaf command and every group that runs on
 * its own, except one marked
 * `mcp: false` (on itself or a group above it), one with a `lifetime` — an agent call must return — and one the
 * profile's levels refuse. Its input is the command's arguments and options in snake_case, typed as far as the
 * command tree and the shared flag vocabulary say; an option marked `mcp: false` is left out.
 */
export const toolsFromCommands = (commands: readonly CommandInfo[], options: CatalogueOptions = {}): AgentTool[] => {
  const { root = [], exclude = [], levels, keyOf } = options
  return flatten(commands)
    .filter(
      (info) =>
        // A group that also runs on its own declares effects: `tasks duplicates` lists, its subcommands decide.
        (info.commands.length === 0 || info.effects !== undefined) &&
        info.path.length > root.length &&
        startsWith(info.path, root) &&
        !exclude.some((skipped) => startsWith(info.path.slice(root.length), skipped)) &&
        info.mcp !== false &&
        info.lifetime === undefined &&
        (levels === undefined || refusal(info, levels, keyOf) === undefined),
    )
    .map((info) => ({
      command: info.path.slice(root.length).join(" "),
      path: info.path,
      title: info.summary ?? info.description,
      description: info.description,
      writes: writes(info.effects),
      input: schemaOf(fieldsOf(info, options)),
      ...(info.output ? { output: info.output } : {}),
    }))
}

const argvOf = (
  info: CommandInfo,
  input: Record<string, unknown>,
  profile: string,
  stdin: CatalogueOptions["stdin"],
): { argv: string[]; stdin?: string } => {
  const fields = fieldsOf(info, { offline: true, ...(stdin ? { stdin } : {}) })
  const known = new Map(fields.map((field) => [field.name, field]))
  for (const name of Object.keys(input))
    if (!known.has(name)) throw new CliError("validation_error", `${info.path.join(" ")}: no argument "${name}"`)
  const options: string[] = []
  const positionals: string[] = []
  let given: string | undefined
  for (const field of fields) {
    const value = input[field.name]
    if (value === undefined) {
      if (field.required) throw new CliError("validation_error", `${info.path.join(" ")}: "${field.name}" is required`)
      continue
    }
    if (field.stdin) given = typeof value === "string" ? value : JSON.stringify(value)
    for (const token of field.argv(value)) (field.positional ? positionals : options).push(token)
  }
  // Values never reach commander as tokens of their own, and positionals come after `--`: no value becomes a flag.
  const argv = [profile, ...info.path, ...options, "--json", ...(positionals.length > 0 ? ["--", ...positionals] : [])]
  return given === undefined ? { argv } : { argv, stdin: given }
}

/**
 * Runs one command for an agent through the CLI itself, in this process: the same parsing, guard, answer and
 * error as on the command line. The answer comes back as the object the command rendered, and a failure as the
 * error object the CLI would print. A write at level `ask` goes ahead (NEED-773); the server's stricter levels
 * apply, to the check before the run and to the command's own guard. With `connection`, the command borrows the
 * server's open connection and never opens one of its own. Which commands are offered is the catalogue's
 * decision (`toolsFromCommands`); this runs what it is handed, except a command that never returns.
 */
export const runCommandForAgent = async (
  program: AgentProgram,
  path: readonly string[],
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<AgentAnswer> => {
  try {
    const info = flatten(program.commands).find((one) => one.path.length === path.length && startsWith(one.path, path))
    // A group runs when it declares effects of its own, as `toolsFromCommands` offers it: `tasks duplicates` lists.
    if (!info || (info.commands.length > 0 && info.effects === undefined))
      throw new CliError("validation_error", `no command "${path.join(" ")}" to run`)
    if (info.lifetime)
      throw new CliError("validation_error", `"${path.join(" ")}" runs until it is stopped; an agent call must return`)
    const levels = ctx.levels?.()
    const refused = levels && refusal(info, levels, ctx.keyOf)
    if (refused) throw new CliError("permission_error", `${path.join(" ")}: ${refused}`, { sent: false })
    const { argv, stdin } = argvOf(info, input, ctx.profile, ctx.stdin)
    const lend = ctx.connection
    let borrowed: Promise<MessengerAdapter> | undefined

    let answered = false
    let result: unknown
    let failure: ErrorObject | undefined
    const streams = captureStreams()
    const code = await program.run(argv, {
      ...ctx.environment,
      streams,
      tty: false,
      ...(ctx.env ? { env: ctx.env } : {}),
      stdin: Readable.from(stdin === undefined ? [] : [stdin]),
      answer: () => null,
      agent: {
        result: (value) => {
          answered = true
          result = value
        },
        failure: (object) => {
          failure = object
        },
        ...(ctx.overrides?.length ? { overrides: ctx.overrides } : {}),
      },
      // Opened only when the command asks: a read the store answers never connects.
      ...(lend
        ? {
            relayed: {
              profile: ctx.profile,
              cwd: process.cwd(),
              connection: () => (borrowed ??= lend().then((adapter) => lentConnection(adapter))),
            },
          }
        : {}),
    })
    if (failure) return { error: failure }
    if (answered) return { result }
    if (code !== 0) throw new CliError("invalid_response", `the command exited with ${code} and said nothing`)
    if (streams.stdout.length > 0)
      throw new CliError(
        "invalid_response",
        "the command printed its answer instead of handing it over — the CLI's run must pass its whole environment on",
      )
    return { result: null }
  } catch (error) {
    return { error: errorObjectOf(error) }
  }
}
