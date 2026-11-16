import { CliError, isCliError } from "@wirecat/cli-base"
import type { ManifestOperation, SchemaNode } from "@wirecat/cli-base/codegen"
import { annotate } from "@wirecat/cli-base/commands"
import type { FetchLike } from "@wirecat/cli-base/http"
import { Command } from "commander"
import type * as v from "valibot"
import type { AppIdentity } from "../ports/app.js"
import { guardFor } from "../sends/guard.js"
import { guardedWrite } from "../sends/guarded.js"
import { keyedGuard } from "../sends/keyed-guard.js"
import type { Level, PermissionKey } from "../sends/permissions.js"
import { levelFor } from "../sends/permissions.js"
import { newOperationId } from "../sends/send-id.js"
import { refusedPlace } from "../sends/upload.js"
import { generatedApiCommand } from "./bot/api.js"
import { httpApiExecutor, httpApiRequest } from "./bot/api-http.js"
import { checkApiBody, checkApiParameter, parseApiJson, readApiBody } from "./bot/api-input.js"
import { baseContext, outputFor } from "./context.js"
import { NO_EFFECTS } from "./effects.js"
import { itemOf, listOf, renderAnswer } from "./envelope.js"
import { queryTerms, termField, withQuery } from "./list-query.js"
import { terminalAsker } from "./messenger/ask.js"
import type { ConditionalKey } from "./permission-keys.js"
import type { Configuration } from "./settings.js"

/**
 * A generated operation, with what the generator may know about deleting. Both fields are optional until cli-base's
 * manifest writes them; a CLI may add them by hand meanwhile.
 */
export interface ServiceApiOperation extends ManifestOperation {
  /** The key a delete through this operation also checks, `pages.delete`; the CLI's `deleteKey` otherwise. */
  deleteKey?: string
  /** Body fields that delete when `true`, as `in_trash` or `archived`. */
  deletingFields?: readonly string[]
}

/** What both halves of the group, the permissions and the command, are built from. */
export interface ServiceApiPermissionsInput {
  operations: readonly ServiceApiOperation[]
  /** The key every delete also checks, `documents.delete`, so denying it holds over `api` as over the CLI's own commands. */
  deleteKey?: string
  /**
   * Operations, by command name, whose body can delete in a way no top-level field names: `agent-batch` with an action
   * `delete`. The body comes parsed by lossless-json, so a number is a `LosslessNumber`.
   */
  deletingBodies?: Readonly<Record<string, (body: unknown) => boolean>>
}

export interface ServiceApiOptions extends ServiceApiPermissionsInput {
  app: AppIdentity
  configuration: Configuration
  /** The service's name in messages: "Notion". */
  service: string
  /** The server the spec names; a path template is appended to its path. */
  baseUrl: string
  /** The host-checked fetch with the CLI's pace and its retry of reads (cli-base `retrying` over `hostFetch`). */
  fetch: (command: Command) => FetchLike
  /** The sign-in headers; read before any guard asks, so a missing sign-in fails first. */
  headers: (command: Command, operation: ManifestOperation) => Record<string, string> | Promise<Record<string, string>>
  /** Loaded only once an operation is about to check its input: a large spec is megabytes of code. */
  schemas: () => Promise<Readonly<Record<string, v.GenericSchema>>>
  /** Loaded only by `api show`. */
  definitions: () => Promise<Readonly<Record<string, SchemaNode>>>
  /** Operations the spec has and the CLI does not offer, each with why; `api show` names the reason. */
  excluded?: readonly { id: string; reason: string }[]
  /** Fields `api show` adds to every answer, such as the API version the commands send. */
  shown?: Readonly<Record<string, unknown>>
  failure?: (status: number, answer: unknown, operation: ManifestOperation) => CliError | undefined
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

const keyOf = (operation: ManifestOperation): PermissionKey => `api.${operation.command}`

const deleteKeyOf = (input: ServiceApiPermissionsInput, operation: ServiceApiOperation) =>
  operation.deleteKey ?? input.deleteKey

/** By its method too: an override may have marked a DELETE as a plain write. */
const destructive = (operation: ManifestOperation) =>
  operation.effect === "destructive" || (operation.binding.kind === "http" && operation.binding.method === "DELETE")

const bodyMayDelete = (input: ServiceApiPermissionsInput, operation: ServiceApiOperation) =>
  (operation.deletingFields?.length ?? 0) > 0 || input.deletingBodies?.[operation.command] !== undefined

/** Whether one call deletes: by its method, a deleting field set to `true`, or the CLI's own test of the body. */
export const serviceApiDeletes = (
  input: ServiceApiPermissionsInput,
  operation: ServiceApiOperation,
  body: unknown,
): boolean =>
  destructive(operation) ||
  (isObject(body) && (operation.deletingFields ?? []).some((field) => body[field] === true)) ||
  input.deletingBodies?.[operation.command]?.(body) === true

/**
 * The group's half of `commandPermissions`: the delete key each operation also checks, for `--dry-run` and discovery,
 * and the levels a delete starts at. A CLI with keys of its own merges each field with its own, never spreads one
 * over the other. `ask` stops at a terminal; over MCP it goes ahead, so `deny` is what stops an agent.
 */
export const serviceApiPermissions = (
  input: ServiceApiPermissionsInput,
): {
  alsoChecks: (path: readonly string[]) => readonly (PermissionKey | ConditionalKey)[]
  defaults: Readonly<Record<PermissionKey, Level>>
  /** The delete keys, so a profile may name one that no command path spells. */
  extra: readonly PermissionKey[]
} => {
  const deleting = input.operations.filter((operation) => destructive(operation) || bodyMayDelete(input, operation))
  const keys = new Set(deleting.map((operation) => deleteKeyOf(input, operation)).filter((key) => key !== undefined))
  return {
    extra: [...keys],
    alsoChecks: (path) => {
      if (path[0] !== "api" || path.length !== 2) return []
      const operation = deleting.find((one) => one.command === path[1])
      const key = operation && deleteKeyOf(input, operation)
      if (!operation || !key) return []
      return destructive(operation) ? [key] : [{ key, when: "the body deletes, trashes or archives" }]
    },
    defaults: {
      ...Object.fromEntries([...keys].map((key) => [key, "ask" as const])),
      ...Object.fromEntries(
        input.operations.filter(destructive).map((operation) => [keyOf(operation), "ask" as const]),
      ),
    },
  }
}

const rowOf = (operation: ManifestOperation) => ({
  command: operation.command,
  method: operation.binding.kind === "http" ? operation.binding.method : "",
  path: operation.binding.kind === "http" ? operation.binding.path : "",
  effect: operation.effect,
  summary: operation.summary ?? "",
})

const API_QUERY = {
  entity: "api_operation",
  backend: "native",
  fields: [
    termField("effect", "enum", "effect:destructive", { values: ["read", "write", "destructive"] }),
    termField("tag", "kw", "tag:Pages"),
  ],
} as const

/**
 * The raw API of an OpenAPI service as one group: `api list` and `api show` without a request, and one command per
 * operation. Every write goes through the profile's guard on `api.<operation>` and, when it deletes, on the delete key
 * too; the journal records that it ran, never its body. There is no free-form `api call`: a request is always one
 * operation of the spec, with its own key (SEC-196).
 */
export const serviceApiCommand = (options: ServiceApiOptions): Command => {
  const { app, configuration } = options
  // A credential-returning operation needs a bot's `--store-token`; a service CLI signs in through `session` instead.
  const operations = options.operations.filter((operation) => !operation.response?.sensitive)
  const own = serviceApiPermissions(options)
  // The group's own levels hold even where the CLI's permissions left them out.
  const defaults = { ...own.defaults, ...configuration.permissions?.defaults }
  const keyless = options.operations.filter(
    (operation) => (destructive(operation) || bodyMayDelete(options, operation)) && !deleteKeyOf(options, operation),
  )
  if (keyless.length > 0)
    throw new CliError(
      "configuration_error",
      `${keyless.map(({ command }) => command).join(", ")} can delete, but no delete key is set: give the api a deleteKey`,
    )
  let schemas: Readonly<Record<string, v.GenericSchema>> | undefined
  const loaded = () => {
    if (!schemas) throw new CliError("configuration_error", "the api schemas were not loaded before the command ran")
    return schemas
  }

  const operationOf = (name: string): ServiceApiOperation => {
    const found = operations.find((operation) => operation.command === name || operation.id === name)
    if (found) return found
    const left =
      options.excluded?.find((one) => one.id === name) ??
      (options.operations.some((one) => one.command === name || one.id === name)
        ? { reason: "it returns a credential, which is never printed" }
        : undefined)
    throw new CliError(
      "not_found",
      left
        ? `${name} is not offered: ${left.reason}`
        : `no ${options.service} API operation ${name}; see ${app.command} api list`,
    )
  }

  const write =
    (extra: readonly PermissionKey[]) =>
    async (command: Command, operation: ManifestOperation, send: () => Promise<unknown>) => {
      const { settings, env, renderer, run } = baseContext(command, configuration.resolveSettings)
      const operationId = newOperationId()
      const guard = keyedGuard(
        (ask) =>
          guardFor(
            app,
            { ...settings, sendsPerHour: Number.MAX_SAFE_INTEGER, permissionDefaults: defaults },
            renderer.warn,
            env,
            ask,
          ),
        terminalAsker(command),
        (key) => levelFor(settings.permissions, key, defaults).level,
        extra,
      )
      const request = { chatId: null, kind: "edit" as const, key: keyOf(operation), operationId }
      guard.refuse(request)
      try {
        return { operation_id: operationId, result: await guardedWrite(guard, request, () => run(() => send())) }
      } catch (error) {
        if (isCliError(error) && error.code === "outcome_unknown")
          throw new CliError("outcome_unknown", error.message, { ...error.details, operation_id: operationId })
        throw error
      }
    }

  const executorFor = (extra: readonly PermissionKey[]) =>
    httpApiExecutor({
      service: options.service,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      headers: options.headers,
      write: write(extra),
      read: (command, _operation, send) => baseContext(command, configuration.resolveSettings).run(() => send()),
      ...(options.failure ? { failure: options.failure } : {}),
    })

  const generated = generatedApiCommand({
    operations,
    checkParameter: (name, schema, raw) => checkApiParameter(name, schema, raw, loaded()),
    checkBody: (operation, text) => checkApiBody(operation, text, loaded()),
    readBody: (command, body) => {
      if (body.bodyFile !== undefined && body.bodyFile !== "-") {
        const { env } = baseContext(command, configuration.resolveSettings)
        if (refusedPlace(body.bodyFile, app, env))
          throw new CliError(
            "validation_error",
            `--body-file may not read ${body.bodyFile}: it holds sign-ins or state`,
          )
      }
      return readApiBody(body)
    },
    execute: (command, operation: ServiceApiOperation, input) => {
      const text = httpApiRequest(operation, input, options.baseUrl).body
      const key = deleteKeyOf(options, operation)
      const body = text === undefined ? undefined : parseApiJson(text)
      const deletes = key !== undefined && serviceApiDeletes(options, operation, body)
      return executorFor(deletes ? [key] : [])(command, operation, input)
    },
  })

  const list = withQuery(
    annotate(new Command("list"), {
      effects: NO_EFFECTS,
      examples: [`${app.command} api list`, `${app.command} api list effect:destructive --json=command,path`],
    }),
    API_QUERY,
  )
    .description(`list every ${options.service} API operation this CLI offers, without calling ${options.service}`)
    .action(function (this: Command, words: string[]) {
      const terms = queryTerms(words, API_QUERY, "api list")
      const effect = terms.get("effect")
      const tag = terms.get("tag")
      const items = operations
        .filter((one) => (!effect || one.effect === effect) && (!tag || one.tags.includes(tag)))
        .map(rowOf)
      renderAnswer(this, outputFor(this), listOf("api list", { items, limit: items.length, has_more: false }))
    })

  const show = annotate(new Command("show"), {
    effects: NO_EFFECTS,
    examples: [`${app.command} api show ${operations[0]?.command ?? "<operation>"} --json`],
  })
    .description(`show one operation's parameters and request schema, without calling ${options.service}`)
    .argument("<operation>", "the operation, as api list prints it")
    .action(async function (this: Command, name: string) {
      const operation = operationOf(name)
      const definitions = await options.definitions()
      const schema = operation.request?.schema ? definitions[operation.request.schema] : undefined
      renderAnswer(
        this,
        outputFor(this),
        itemOf({ operation, ...options.shown, ...(schema ? { request_schema: schema } : {}) }),
      )
    })

  const group = annotate(new Command("api"), { effects: NO_EFFECTS }).description(
    `the raw ${options.service} API, one command per operation of its OpenAPI document`,
  )
  group.addCommand(list).addCommand(show)
  const load = async () => {
    schemas ??= await options.schemas()
  }
  for (const child of generated.commands) group.addCommand(child.hook("preAction", load))
  return group
}
