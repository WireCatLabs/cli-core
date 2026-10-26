import { CliError } from "@wirecat/cli-base"
import type { ManifestOperation, SchemaNode } from "@wirecat/cli-base/codegen"
import { annotate } from "@wirecat/cli-base/commands"
import { Command, Option } from "commander"
import { secretInput } from "../../runs/run-context.js"
import { REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { apiFlagOf, apiOptionKey, readApiBody } from "./api-input.js"

export interface ApiCommandInput {
  path: Record<string, string>
  query: Record<string, string>
  headers: Record<string, string>
  fields: Record<string, string>
  body?: string
  bodySource?: "argument" | "stdin" | "file"
  tokenProfile?: string
}

export interface ApiCommands {
  operations: readonly ManifestOperation[]
  description?: string
  checkParameter: (name: string, schema: SchemaNode, raw: string) => string | undefined
  checkBody?: (operation: ManifestOperation, text: string | undefined) => string | undefined
  before?: (command: Command, operation: ManifestOperation) => void | Promise<void>
  readBody?: (command: Command, options: { body?: string; bodyFile?: string }) => string | undefined
  execute: (command: Command, operation: ManifestOperation, input: ApiCommandInput) => Promise<void>
}

export const generatedApiCommand = (api: ApiCommands): Command => {
  const group = new Command("api").description(
    api.description ?? "every operation of the official Bot API, generated from its schema",
  )
  group.option(
    "--store-token <profile>",
    "keep a returned authentication token only in this bot profile's OS keyring; never print it",
  )
  for (const operation of api.operations) {
    const binding =
      operation.binding.kind === "http"
        ? `${operation.binding.method} ${operation.binding.path}`
        : operation.binding.name
    const command = annotate(new Command(operation.command), {
      effects: operation.effect === "read" ? REMOTE_READ : REMOTE_WRITE,
    }).description(`${operation.summary ?? operation.id} — ${operation.effect} (${binding})`)
    for (const parameter of operation.parameters) {
      if (parameter.sensitive) continue
      const option = new Option(
        `--${apiFlagOf(parameter.name)} <value>`,
        parameter.description?.split("\n")[0] ?? parameter.name,
      )
      command.addOption(parameter.required && parameter.in !== "body" ? option.makeOptionMandatory() : option)
    }
    if (operation.request) {
      // A field the schema marks secret may ride in an inline body, and the flags never see it.
      command.addOption(secretInput(new Option("--body <json>", "the request body as JSON; - reads it from stdin")))
      command.option("--body-file <path>", "the request body from a JSON file; - is stdin")
    }
    annotate(command, {
      origin: "generated",
      api_operation: operation.id,
      effects: { remote: operation.effect === "read" ? "read" : "write", local: "none" },
    })
    command.action(async function (this: Command) {
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
      await api.before?.(this, operation)
      const text = (api.readBody ?? ((_command, body) => readApiBody(body)))(this, options)
      if (options.body !== undefined) input.bodySource = options.body === "-" ? "stdin" : "argument"
      else if (options.bodyFile !== undefined) input.bodySource = options.bodyFile === "-" ? "stdin" : "file"
      const body = operation.binding.kind === "rpc" ? text : api.checkBody ? api.checkBody(operation, text) : text
      if (body !== undefined) input.body = body
      await api.execute(this, operation, input)
    })
    group.addCommand(command)
  }
  return group
}
