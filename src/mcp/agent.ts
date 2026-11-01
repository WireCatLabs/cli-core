import { Readable } from "node:stream"
import { CliError, captureStreams, errorObjectOf } from "@wirecat/cli-base"
import {
  type ArgumentInfo,
  type CommandInfo,
  type CommandOutput,
  flatten,
  type OptionInfo,
} from "@wirecat/cli-base/commands"
import { queryDescription } from "@wirecat/cli-base/query"
import { type ErrorObject, writes } from "@wirecat/cli-base/standards"
import { VOCABULARY } from "@wirecat/cli-base/standards/tables"
import * as v from "valibot"
import { type CommandAvailability, commandAvailability } from "../cli/command-availability.js"
import { changesMessenger } from "../cli/effects.js"
import { QUERY_ARGUMENT } from "../cli/list-query.js"
import type { CommandPermissions } from "../cli/permission-keys.js"

export type { CommandAvailability } from "../cli/command-availability.js"

import { lentConnection } from "../cli/messenger/serve-relay.js"
import type { RunOptions } from "../cli/program.js"
import type { StdinField } from "../cli/stdin-field.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import { newRunId } from "../runs/run.js"
import type { RunCaller } from "../runs/run-context.js"
import { enclosingTraceId, inRun, traceOf } from "../runs/scope.js"
import { authorityAllowed, botApiAllowed, type Level, type PermissionKey } from "../sends/permissions.js"
import { currentCaller } from "./caller.js"

/** The CLI's own `run` — a fresh program on every call — and its command tree as `commands --json` describes it. */
export interface AgentProgram {
  run: (argv: string[], environment: RunOptions) => Promise<number>
  commands: readonly CommandInfo[]
}

export interface AgentContext {
  profile: string
  readOnly?: boolean
  env?: NodeJS.ProcessEnv
  /** The levels in force now, this server's stricter ones included; read on every call. */
  levels?: () => Readonly<Record<PermissionKey, Level>>
  /** This server's own stricter levels, `key=level`, which the command's guard applies too. */
  overrides?: readonly string[]
  /** The key a CLI's own command is checked against, when `keyForCommand` does not know it. */
  keyOf?: (path: readonly string[]) => PermissionKey | null | undefined
  /** A declared CLI's keys and defaults (`configuration.permissions`); in place of `keyOf`. */
  permissions?: CommandPermissions | undefined
  authority?: CatalogueOptions["authority"]
  /** The server's one open connection. The command borrows it: it cannot close it, and never opens its own. */
  connection?: () => Promise<MessengerAdapter>
  /** What a command reads on stdin, as the field an agent gives it in. */
  stdin?: (path: readonly string[]) => StdinField | undefined
  /** More of the run's environment, read by the commands that look for it: the server's `spawnJob`, `embedders`. */
  environment?: Readonly<Record<string, unknown>>
  /** Who made the call (`callerOf`); the run records it rather than this server's environment. */
  caller?: RunCaller
}

export type AgentAnswer = { result: unknown } | { error: ErrorObject }

export interface AgentTool {
  availability?: () => CommandAvailability
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
  /** Complete discovery, including blocked commands. Omit to preserve the legacy executable-only projection. */
  includeUnavailable?: boolean
  /** The subtree a server is built from: `["bot"]` for the bot server. */
  root?: readonly string[]
  /** Subtrees under the root left out: the personal server leaves out `["bot"]`. */
  exclude?: readonly (readonly string[])[]
  /** Current levels annotate availability without removing commands from discovery. */
  currentLevels?: () => Readonly<Record<PermissionKey, Level>>
  levels?: Readonly<Record<PermissionKey, Level>>
  /** Whether a read-only lock currently blocks messenger changes. */
  readOnly?: boolean
  keyOf?: (path: readonly string[]) => PermissionKey | null | undefined
  /** A declared CLI's keys and defaults (`configuration.permissions`); in place of `keyOf`. */
  permissions?: CommandPermissions | undefined
  /** Whether a command changes what a later run may do (`grantsAuthority`): execution requires `mcp.authority`. */
  authority?: (path: readonly string[]) => boolean
  /** Whether a command only fetches into this machine (`fetchesOnlyAt`): offered as a read. Unset, every write stays one. */
  fetchOnly?: (path: readonly string[]) => boolean
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

type ValueKind = "switch" | "count" | "number" | "list" | "variadic" | "repeat" | "json" | "text"

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
  if (Array.isArray(option.default)) return "repeat"
  return /\.\.\.[>\]]/.test(option.flags) ? "variadic" : "text"
}

// The command line's own promise: `--location ""` clears the field, so an agent may send "" too.
const CLEARS = /\bempty clears\b/

const optionField = (option: OptionInfo, long: string, negated?: OptionInfo): Field => {
  const kind = optionKind(option, long)
  const about = negated ? `${option.description}; false: ${negated.description}` : option.description
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
            : kind === "list" || kind === "repeat"
              ? // The command line takes `a,b` or the flag repeated; an agent may write one value, or a list.
                v.pipe(v.union([v.pipe(v.array(text("one value")), v.minLength(1)), text(about)]), v.description(about))
              : kind === "variadic"
                ? v.pipe(v.array(text("one value")), v.minLength(1), v.description(about))
                : kind === "json"
                  ? // A next step hands back the object an answer gave; the command takes it as JSON text.
                    v.pipe(v.union([v.string(), v.record(v.string(), v.unknown())]), v.description(about))
                  : CLEARS.test(about)
                    ? v.pipe(v.string(), v.regex(/^(?!-$)/, "not only -"), v.description(about))
                    : text(about)
  return {
    name: snake(long.slice(2)),
    required: option.mandatory,
    schema,
    positional: false,
    argv: (value) => {
      // `approval: false` where the command has `--no-approval` says so; elsewhere false is leaving the switch off.
      if (kind === "switch") return value === true ? [long] : negated ? [`--no-${long.slice(2)}`] : []
      if (kind === "variadic") return (value as unknown[]).map((one) => `${long}=${String(one)}`)
      if (kind === "repeat") return (Array.isArray(value) ? value : [value]).map((one) => `${long}=${String(one)}`)
      if (kind === "list") return [`${long}=${Array.isArray(value) ? value.map(String).join(",") : String(value)}`]
      if (kind === "json") return [`${long}=${typeof value === "string" ? value : JSON.stringify(value)}`]
      return [`${long}=${String(value)}`]
    },
  }
}

/** A list's query names its fields here: the help's Fields section, which its description points to, is not sent. */
const argumentField = (argument: ArgumentInfo, query?: CommandInfo["query"]): Field => {
  const own = argument.description || argument.name
  const about =
    query && argument.name === "query"
      ? own === QUERY_ARGUMENT
        ? queryDescription(query)
        : `${own}; ${queryDescription(query)}`
      : own
  const one = argument.choices
    ? v.pipe(v.picklist(argument.choices as string[]), v.description(argument.description))
    : text(about)
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
  const fields: Field[] = info.arguments.map((argument) => argumentField(argument, info.query))
  const read = stdin?.(info.path)
  if (read) fields.push(stdinField(read))
  const switches = new Map(info.options.filter((one) => !one.takes_value).map((one) => [longOf(one), one]))
  for (const option of info.options) {
    const long = longOf(option)
    if (!long || option.mcp === false) continue
    // `--x` false already says `--no-x`: one boolean, not two that could disagree.
    const positive = long.startsWith("--no-") ? switches.get(`--${long.slice(5)}`) : undefined
    if (positive && positive.mcp !== false) continue
    const field = optionField(option, long, option.takes_value ? undefined : switches.get(`--no-${long.slice(2)}`))
    // A positional and its flag alternative share one MCP input; emitting both supplies the value twice.
    if (!fields.some((existing) => existing.name === field.name)) fields.push(field)
  }
  if (offline && info.effects?.remote === "read" && info.offline !== false) fields.push(OFFLINE)
  return fields.filter((field) => !omit.includes(field.name))
}

const schemaOf = (fields: readonly Field[]) =>
  v.object(
    Object.fromEntries(fields.map((field) => [field.name, field.required ? field.schema : v.optional(field.schema)])),
  )

const startsWith = (path: readonly string[], prefix: readonly string[]) => prefix.every((word, at) => path[at] === word)

/** Build the discoverable command catalogue; profile permissions annotate availability. */
export const toolsFromCommands = (commands: readonly CommandInfo[], options: CatalogueOptions = {}): AgentTool[] => {
  const { root = [], exclude = [], levels, keyOf, authority, readOnly = false, permissions } = options
  return flatten(commands)
    .filter(
      (info) =>
        // A group is offered only when it runs on its own; without an action it only prints its help.
        (info.commands.length === 0 || info.runnable === true) &&
        info.path.length > root.length &&
        startsWith(info.path, root) &&
        !exclude.some((skipped) => startsWith(info.path.slice(root.length), skipped)) &&
        info.mcp !== false &&
        info.lifetime === undefined &&
        (options.includeUnavailable === true ||
          (!(readOnly && (changesMessenger(info) || authority?.(info.path))) &&
            (levels === undefined && !(readOnly && permissions)
              ? true
              : commandAvailability(info, levels ?? {}, keyOf, authority, readOnly, true, permissions).available))),
    )
    .map((info) => ({
      availability: () =>
        commandAvailability(
          info,
          options.currentLevels?.() ?? levels ?? {},
          keyOf,
          authority,
          readOnly,
          true,
          permissions,
        ),
      command: info.path.slice(root.length).join(" "),
      path: info.path,
      title: info.summary ?? info.description,
      description: info.description,
      writes: writes(info.effects) && options.fetchOnly?.(info.path) !== true,
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
    if (!info || (info.commands.length > 0 && info.runnable !== true))
      throw new CliError("validation_error", `no command "${path.join(" ")}" to run`)
    if (info.lifetime)
      throw new CliError("validation_error", `"${path.join(" ")}" runs until it is stopped; an agent call must return`)
    const levels = ctx.levels?.()
    const availability =
      (levels || ctx.readOnly || ctx.permissions) &&
      commandAvailability(info, levels ?? {}, ctx.keyOf, ctx.authority, ctx.readOnly, true, ctx.permissions)
    if (availability && !availability.available)
      throw new CliError("permission_error", `${path.join(" ")}: ${availability.reason}`, {
        sent: false,
        ...(availability.permission ? { permission: availability.permission } : {}),
      })
    const { argv, stdin } = argvOf(info, input, ctx.profile, ctx.stdin)
    const lend = ctx.connection
    let borrowed: Promise<MessengerAdapter> | undefined

    let answered = false
    let result: unknown
    let failure: ErrorObject | undefined
    const streams = captureStreams()
    const command = `mcp ${path.join(" ")}`
    const traceId = enclosingTraceId() ?? traceOf(ctx.env ?? {}).traceId
    // Its own run for each call: outside one, every answer of a server would name the server process's run.
    const scope = {
      runId: newRunId(new Date(), command),
      command,
      startedAt: Date.now(),
      profile: ctx.profile,
      ...(traceId === undefined ? {} : { traceId }),
    }
    const code = await inRun(scope, () =>
      program.run(argv, {
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
          authority: levels !== undefined && authorityAllowed(levels),
          botApi: levels !== undefined && botApiAllowed(levels),
          ...((ctx.caller ?? currentCaller()) ? { caller: ctx.caller ?? currentCaller() } : {}),
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
      }),
    )
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
