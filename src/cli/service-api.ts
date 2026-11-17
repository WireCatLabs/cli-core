import { CliError, isCliError } from "@wirecat/cli-base"
import type { ManifestOperation, OperationPermission, SchemaNode } from "@wirecat/cli-base/codegen"
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
import { type ApiCommandInput, generatedApiCommand } from "./bot/api.js"
import { type HttpApiRequest, httpApiRequest, httpApiSend, unsendableBody } from "./bot/api-http.js"
import { checkApiBody, checkApiParameter, parseApiJson, readApiBody, readApiBytes } from "./bot/api-input.js"
import { baseContext, outputFor } from "./context.js"
import { NO_EFFECTS } from "./effects.js"
import { itemOf, listOf, renderAnswer } from "./envelope.js"
import { queryTerms, termField, withQuery } from "./list-query.js"
import { terminalAsker } from "./messenger/ask.js"
import type { ConditionalKey } from "./permission-keys.js"
import {
  manifestBaseUrl,
  nextPage,
  parameterValue,
  type ServiceApiManifest,
  signRequest,
} from "./service-api-manifest.js"
import type { Configuration } from "./settings.js"

/** A key a call's body implies in a way no flag names, as notion's `agent-batch` with an action `delete`. */
export interface BodyPermission {
  key: PermissionKey
  /** When it applies, in a few words, for `--dry-run` and discovery. */
  when: string
  /** The body parsed by lossless-json: a number is a `LosslessNumber`. */
  applies: (body: unknown) => boolean
}

/** What both halves of the group, the permissions and the command, are built from. */
export interface ServiceApiPermissionsInput {
  manifest: ServiceApiManifest
  /** By command name: keys beside the manifest's `permissions`, for a body the generator cannot read. */
  bodyPermissions?: Readonly<Record<string, readonly BodyPermission[]>>
}

export interface ServiceApiOptions extends ServiceApiPermissionsInput {
  app: AppIdentity
  configuration: Configuration
  /** The service's name in messages: "Notion". */
  service: string
  /** In place of the manifest's first server. */
  baseUrl?: string
  /** The host-checked fetch with the CLI's pace and its retry of reads (cli-base `retrying` over `hostFetch`). */
  fetch: (command: Command) => FetchLike
  /**
   * The profile's token, sent where the operation's security scheme names. Read before any guard asks. Left out, for a
   * CLI without sign-in, no call carries one.
   */
  token?: (command: Command) => string | Promise<string>
  /** Headers beside the sign-in, such as the API version. */
  headers?: (command: Command, operation: ManifestOperation) => Record<string, string>
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

/**
 * The operations the `api` group offers, and why it leaves out the rest: one that answers with a credential needs a
 * bot's `--store-token`, as a service CLI signs in through `session`; a body other than JSON or an upload's bytes (a
 * multipart form) the generated command cannot send.
 */
export const serviceApiOperations = (
  manifest: ServiceApiManifest,
): { offered: readonly ManifestOperation[]; left: readonly { id: string; reason: string }[] } => {
  const reasonOf = (operation: ManifestOperation) =>
    operation.response?.sensitive ? "it returns a credential, which is never printed" : unsendableBody(operation)
  return {
    offered: manifest.operations.filter((operation) => reasonOf(operation) === undefined),
    left: manifest.operations.flatMap((operation) => {
      const reason = reasonOf(operation)
      return reason ? [{ id: operation.id, reason }] : []
    }),
  }
}

/** How far `--all` reads: a service that never stops paging must not run a command forever. */
const MOST_PAGES = 500

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

const keyOf = (operation: ManifestOperation): PermissionKey => `api.${operation.command}`

const permissionsOf = (operation: ManifestOperation): readonly OperationPermission[] => operation.permissions ?? []

/** By its method too: an override may have marked a DELETE as a plain write. */
const destructive = (operation: ManifestOperation) =>
  operation.effect === "destructive" || (operation.binding.kind === "http" && operation.binding.method === "DELETE")

const flagsOf = ({ body = [], query = [] }: OperationPermission) => [...body, ...query]

/** A flag counts unless it is absent or plainly false: a service may read `1` or `True` as true. */
const set = (value: unknown) => value !== undefined && value !== null && value !== false && value !== "false"

/** Whether a manifest key applies to this call: always, or when one of its flags is set. */
const applies = (permission: OperationPermission, body: unknown, input: ApiCommandInput): boolean =>
  flagsOf(permission).length === 0 ||
  (permission.body ?? []).some((field) => isObject(body) && set(body[field])) ||
  (permission.query ?? []).some((name) => set(input.query[name]))

/** The keys one call checks beside `api.<operation>`: the manifest's that apply, and the CLI's from the body. */
export const serviceApiKeys = (
  input: ServiceApiPermissionsInput,
  operation: ManifestOperation,
  call: ApiCommandInput,
): PermissionKey[] => {
  const body = call.body?.trim() ? parseApiJson(call.body) : undefined
  const keys = [
    ...permissionsOf(operation)
      .filter((permission) => applies(permission, body, call))
      .map(({ key }) => key),
    ...(input.bodyPermissions?.[operation.command] ?? []).filter((one) => one.applies(body)).map(({ key }) => key),
  ]
  return [...new Set(keys)]
}

/**
 * The group's half of `commandPermissions`: the keys each operation also checks, for `--dry-run` and discovery, and
 * `ask` for each of them and for every operation that deletes. A CLI with keys of its own merges each field with its
 * own, never spreads one over the other. `ask` stops at a terminal; over MCP it goes ahead, so `deny` is what stops an
 * agent.
 */
export const serviceApiPermissions = (
  input: ServiceApiPermissionsInput,
): {
  alsoChecks: (path: readonly string[]) => readonly (PermissionKey | ConditionalKey)[]
  defaults: Readonly<Record<PermissionKey, Level>>
  /** The keys, so a profile may name one that no command path spells. */
  extra: readonly PermissionKey[]
} => {
  const checks = new Map<string, (PermissionKey | ConditionalKey)[]>()
  for (const operation of input.manifest.operations)
    checks.set(operation.command, [
      ...permissionsOf(operation).map((permission) =>
        flagsOf(permission).length === 0
          ? permission.key
          : { key: permission.key, when: `with ${flagsOf(permission).join(" or ")} set` },
      ),
      ...(input.bodyPermissions?.[operation.command] ?? []).map(({ key, when }) => ({ key, when })),
    ])
  const keys = [...new Set([...checks.values()].flat().map((one) => (typeof one === "string" ? one : one.key)))]
  return {
    extra: keys,
    alsoChecks: (path) => (path[0] === "api" && path.length === 2 ? (checks.get(path[1] ?? "") ?? []) : []),
    defaults: {
      ...Object.fromEntries(keys.map((key) => [key, "ask" as const])),
      ...Object.fromEntries(
        input.manifest.operations.filter(destructive).map((operation) => [keyOf(operation), "ask" as const]),
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
 * operation of the generated manifest, sent to its server with the sign-in its security scheme names. Every write goes
 * through the profile's guard on `api.<operation>` and on each manifest key that applies to the call (`files.delete`
 * when `permanently` is true); the journal records that it ran, never its body. A read that pages takes `--all`. There
 * is no free-form `api call`: a request is always one operation of the spec, with its own key (SEC-196).
 */
export const serviceApiCommand = (options: ServiceApiOptions): Command => {
  const { app, configuration, manifest } = options
  const { offered: operations, left } = serviceApiOperations(manifest)
  const baseUrl = manifestBaseUrl(manifest, options.baseUrl)
  const base = new URL(baseUrl)
  const own = serviceApiPermissions(options)
  // The group's own levels hold even where the CLI's permissions left them out.
  const defaults = { ...own.defaults, ...configuration.permissions?.defaults }
  const unguarded = operations.filter(
    (operation) => destructive(operation) && !permissionsOf(operation).some(({ key }) => key.endsWith(".delete")),
  )
  if (unguarded.length > 0)
    throw new CliError(
      "configuration_error",
      `${unguarded.map(({ command }) => command).join(", ")} can delete, but the manifest gives no delete key: generate with \`permissions\``,
    )
  const named = new Set(manifest.operations.flatMap((operation) => permissionsOf(operation).map(({ key }) => key)))
  const unnamed = Object.values(options.bodyPermissions ?? {})
    .flat()
    .filter(({ key }) => !named.has(key))
  if (unnamed.length > 0)
    throw new CliError(
      "configuration_error",
      `bodyPermissions name ${unnamed.map(({ key }) => key).join(", ")}, which the manifest does not: the keys come from \`permissions\``,
    )
  let schemas: Readonly<Record<string, v.GenericSchema>> | undefined
  const loaded = () => {
    if (!schemas) throw new CliError("configuration_error", "the api schemas were not loaded before the command ran")
    return schemas
  }
  const send = httpApiSend({
    service: options.service,
    fetch: options.fetch,
    ...(options.failure ? { failure: options.failure } : {}),
  })

  const operationOf = (name: string): ManifestOperation => {
    const found = operations.find((operation) => operation.command === name || operation.id === name)
    if (found) return found
    const id = manifest.operations.find((one) => one.command === name || one.id === name)?.id ?? name
    const why = options.excluded?.find((one) => one.id === name) ?? left.find((one) => one.id === id)
    throw new CliError(
      "not_found",
      why
        ? `${name} is not offered: ${why.reason}`
        : `no ${options.service} API operation ${name}; see ${app.command} api list`,
    )
  }

  const signed = async (command: Command, operation: ManifestOperation, request: HttpApiRequest) => {
    const { token } = options
    await signRequest(manifest, operation, request, token && (() => token(command)))
    for (const [name, value] of Object.entries(options.headers?.(command, operation) ?? {}))
      request.headers.set(name, value)
    return request
  }

  const write = async (
    command: Command,
    operation: ManifestOperation,
    extra: readonly PermissionKey[],
    request: HttpApiRequest,
  ) => {
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
    const guarded = { chatId: null, kind: "edit" as const, key: keyOf(operation), operationId }
    guard.refuse(guarded)
    try {
      const result = await guardedWrite(guard, guarded, () => run(() => send(command, operation, request)))
      return { operation_id: operationId, result }
    } catch (error) {
      if (isCliError(error) && error.code === "outcome_unknown")
        throw new CliError("outcome_unknown", error.message, { ...error.details, operation_id: operationId })
      throw error
    }
  }

  /** Every page, in one run; a next page on another host is never sent the sign-in. */
  const allPages = async (command: Command, operation: ManifestOperation, input: ApiCommandInput) => {
    const pagination = operation.pagination as NonNullable<ManifestOperation["pagination"]>
    // Services number pages from 0 or from 1, and the manifest does not say which.
    if (pagination.style === "page" && parameterValue(input, pagination.page) === undefined)
      throw new CliError(
        "validation_error",
        `--all on ${operation.command} needs the first page: give --${pagination.page.name} 0 or 1, as ${options.service} counts`,
      )
    const items: unknown[] = []
    const asked = new Set<string>()
    let call = input
    let url: URL | undefined
    await baseContext(command, configuration.resolveSettings).run(async () => {
      for (let page = 0; ; page++) {
        if (page >= MOST_PAGES)
          throw new CliError(
            "validation_error",
            `${operation.command} has more than ${MOST_PAGES} pages; narrow it with its own flags, or page it yourself`,
          )
        const unsigned = httpApiRequest(operation, call, baseUrl)
        // A next link replaces the URL, so the request is signed after: a key in the query goes into the link.
        if (url !== undefined) unsigned.url = new URL(url)
        const request = await signed(command, operation, unsigned)
        const key = `${request.url.href} ${request.body ?? ""}`
        if (asked.has(key))
          throw new CliError("invalid_response", `${options.service} gave the same next page twice; nothing more read`)
        asked.add(key)
        const step = nextPage(pagination, call, await send(command, operation, request))
        for (const item of step.items) items.push(item)
        if (!step.next) return
        if ("url" in step.next) {
          url = new URL(step.next.url, request.url)
          if (url.origin !== base.origin)
            throw new CliError("invalid_response", `${options.service} pointed the next page at another host`)
        } else call = step.next.input
      }
    })
    renderAnswer(
      command,
      outputFor(command),
      listOf(`api ${operation.command}`, { items, limit: items.length, has_more: false }),
    )
  }

  const refuseOwnFiles = (command: Command, path: string) => {
    if (path === "-") return
    const { env } = baseContext(command, configuration.resolveSettings)
    if (refusedPlace(path, app, env))
      throw new CliError("validation_error", `--body-file may not read ${path}: it holds sign-ins or state`)
  }

  const generated = generatedApiCommand({
    operations,
    checkParameter: (name, schema, raw) => checkApiParameter(name, schema, raw, loaded()),
    checkBody: (operation, text) => checkApiBody(operation, text, loaded()),
    readBody: (command, body) => {
      if (body.bodyFile !== undefined) refuseOwnFiles(command, body.bodyFile)
      return readApiBody(body)
    },
    readBytes: (command, path) => {
      refuseOwnFiles(command, path)
      return readApiBytes(path)
    },
    execute: async (command, operation, input) => {
      const extra = serviceApiKeys(options, operation, input)
      if (operation.pagination && command.opts<{ all?: unknown }>().all === true) {
        if (operation.effect !== "read" || extra.length > 0)
          throw new CliError(
            "validation_error",
            `--all reads only; this call of ${operation.command} is guarded by ${extra.join(", ") || "its write"}`,
          )
        return allPages(command, operation, input)
      }
      const request = await signed(command, operation, httpApiRequest(operation, input, baseUrl))
      const answer =
        operation.effect === "read" && extra.length === 0
          ? await baseContext(command, configuration.resolveSettings).run(() => send(command, operation, request))
          : await write(command, operation, extra, request)
      renderAnswer(command, outputFor(command), itemOf(answer))
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
  for (const child of generated.commands) {
    const operation = operations.find((one) => one.command === child.name())
    if (operation?.pagination && !operation.parameters.some(({ name }) => name === "all"))
      child.option("--all", "read every page, as the API pages it")
    group.addCommand(child.hook("preAction", load))
  }
  return group
}
