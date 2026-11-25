import { CliError } from "@wirecat/cli-base"
import type { ManifestOperation, SchemaNode } from "@wirecat/cli-base/codegen/runtime"
import { annotate } from "@wirecat/cli-base/commands"
import { Command, Option } from "commander"
import { secretInput } from "../../runs/run-context.js"
import { NO_EFFECTS, REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { API_UNTRUSTED, marksUntrusted } from "../untrusted-marks.js"
import {
  apiFlagOf,
  apiJson,
  apiOptionKey,
  graphqlVariables,
  readApiBody,
  readApiBytes,
  sendsBytes,
} from "./api-input.js"

export interface ApiCommandInput {
  path: Record<string, string>
  query: Record<string, string>
  headers: Record<string, string>
  fields: Record<string, string>
  body?: string
  /** An upload's bytes, from `--body-file`. */
  bytes?: Uint8Array<ArrayBuffer>
  bodySource?: "argument" | "stdin" | "file"
  tokenProfile?: string
  /** A GraphQL operation's selection in place of its default, for a source that needs more than one level. */
  selection?: string
}

export interface ApiCommands {
  operations: readonly ManifestOperation[]
  description?: string
  checkParameter: (name: string, schema: SchemaNode, raw: string) => string | undefined
  checkBody?: (operation: ManifestOperation, text: string | undefined) => string | undefined
  before?: (command: Command, operation: ManifestOperation) => void | Promise<void>
  readBody?: (command: Command, options: { body?: string; bodyFile?: string }) => string | undefined
  /** An upload's file, `-` for stdin. */
  readBytes?: (command: Command, path: string) => Uint8Array<ArrayBuffer>
  execute: (command: Command, operation: ManifestOperation, input: ApiCommandInput) => Promise<void>
  /** Called with each operation's command once it is built, before it is mounted. */
  configure?: (command: Command, operation: ManifestOperation) => void
}

/**
 * The words after `api`: `contacts-list` in the group `contacts` is `contacts list`, `move-page` in `pages` keeps its
 * name, and an operation without a group stays `api <command>`. The same rule as cli-base's `apiCommandPath`; `group`
 * is read as optional, so a manifest generated before groups mounts flat, as it always did.
 */
export const apiPathOf = (operation: ManifestOperation): string[] => {
  const { command, group } = operation as ManifestOperation & { group?: string }
  if (!group) return [command]
  return [group, command.startsWith(`${group}-`) ? command.slice(group.length + 1) : command]
}

const scalarOf = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined

export const generatedApiCommand = (api: ApiCommands): Command => {
  const group = new Command("api").description(
    api.description ?? "every operation of the official Bot API, generated from its schema",
  )
  group.option(
    "--store-token <profile>",
    "keep a returned authentication token only in this bot profile's OS keyring; never print it",
  )
  const subgroups = new Set<Command>()
  for (const operation of api.operations) {
    const binding =
      operation.binding.kind === "http"
        ? `${operation.binding.method} ${operation.binding.path}`
        : operation.binding.kind === "graphql"
          ? `${operation.binding.operation} ${operation.binding.field}`
          : operation.binding.name
    const path = apiPathOf(operation)
    const command = annotate(new Command(path.at(-1)), {
      effects: operation.effect === "read" ? REMOTE_READ : REMOTE_WRITE,
    }).description(`${operation.summary ?? operation.id} — ${operation.effect} (${binding})`)
    for (const parameter of operation.parameters) {
      if (parameter.sensitive) continue
      const option = new Option(
        `--${apiFlagOf(parameter.name)} <value>`,
        parameter.description?.split("\n")[0] ?? parameter.name,
      )
      // A GraphQL flag is the request body, which never reaches the run's files (SEC-196).
      if (operation.binding.kind === "graphql" && parameter.in === "body") secretInput(option)
      if (parameter.required && parameter.in !== "body") {
        // A required parameter the spec gives a default (Notion's `Notion-Version`) is sent with it, never asked for.
        const fallback = scalarOf(parameter.schema.default)
        if (fallback === undefined) option.makeOptionMandatory()
        else option.default(fallback)
      }
      command.addOption(option)
    }
    if (operation.request && sendsBytes(operation)) {
      command.option("--body-file <path>", `the file to upload, sent as ${operation.request.contentType}; - is stdin`)
    } else if (operation.request) {
      // A field the schema marks secret may ride in an inline body, and the flags never see it.
      command.addOption(secretInput(new Option("--body <json>", "the request body as JSON; - reads it from stdin")))
      command.option("--body-file <path>", "the request body from a JSON file; - is stdin")
    }
    marksUntrusted(command, API_UNTRUSTED)
    annotate(command, {
      origin: "generated",
      api_operation: operation.id,
      effects: { remote: operation.effect === "read" ? "read" : "write", local: "none" },
    })
    command.action(async function (this: Command) {
      // First: a refusal by the profile holds whatever the flags and the body say.
      await api.before?.(this, operation)
      const options = this.opts<Record<string, string | undefined>>()
      const input: ApiCommandInput = { path: {}, query: {}, headers: {}, fields: {} }
      const tokenProfile = group.opts<{ storeToken?: string }>().storeToken
      if (operation.response?.sensitive) {
        if (!tokenProfile?.trim())
          throw new CliError(
            "validation_error",
            "--store-token <profile> is required for this credential-returning operation",
          )
        input.tokenProfile = tokenProfile
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(tokenProfile))
          throw new CliError(
            "validation_error",
            "--store-token needs a bot profile name using letters, digits, underscores or hyphens",
          )
      } else if (tokenProfile !== undefined) {
        throw new CliError("validation_error", "--store-token is only supported for credential-returning operations")
      }
      for (const parameter of operation.parameters) {
        const raw = options[apiOptionKey(parameter.name)]
        if (raw === undefined) continue
        if (parameter.in !== "body") {
          const problem = api.checkParameter(parameter.name, parameter.schema, raw)
          if (problem) throw new CliError("validation_error", problem)
        }
        const target =
          parameter.in === "body" ? input.fields : parameter.in === "header" ? input.headers : input[parameter.in]
        target[parameter.name] = raw
      }
      if (sendsBytes(operation)) {
        const path = options.bodyFile
        if (path === undefined && operation.request?.required)
          throw new CliError(
            "validation_error",
            `${operation.command} uploads a file: give --body-file <path>, or - for stdin`,
          )
        if (path !== undefined) {
          input.bytes = (api.readBytes ?? ((_command, from) => readApiBytes(from)))(this, path)
          input.bodySource = path === "-" ? "stdin" : "file"
        }
        await api.execute(this, operation, input)
        return
      }
      const text = (api.readBody ?? ((_command, body) => readApiBody(body)))(this, options)
      if (options.body !== undefined) input.bodySource = options.body === "-" ? "stdin" : "argument"
      else if (options.bodyFile !== undefined) input.bodySource = options.bodyFile === "-" ? "stdin" : "file"
      // A GraphQL body is all the variables: the flags join it here, so the schema check sees what is sent.
      const given =
        operation.binding.kind === "graphql" ? apiJson(graphqlVariables(operation, text, input.fields)) : text
      if (operation.binding.kind === "graphql") input.fields = {}
      const body = operation.binding.kind === "rpc" ? text : api.checkBody ? api.checkBody(operation, given) : given
      if (body !== undefined) input.body = body
      await api.execute(this, operation, input)
    })
    api.configure?.(command, operation)
    const [first] = path
    const taken = group.commands.find((one) => one.name() === first)
    // A command and a group of one name would put an operation under another's command, or answer with the wrong one.
    if (taken && (path.length === 1 || !subgroups.has(taken)))
      throw new CliError("configuration_error", `api ${first} is both a group and an operation: rename one`)
    if (path.length === 1 || first === undefined) {
      group.addCommand(command)
      continue
    }
    const subgroup =
      taken ?? annotate(new Command(first), { effects: NO_EFFECTS }).description(`the ${first} operations`)
    if (!taken) {
      subgroups.add(subgroup)
      group.addCommand(subgroup)
    }
    subgroup.addCommand(command)
  }
  return group
}
