import { CliError, isCliError } from "@wirecat/cli-base"
import type { ManifestOperation, OperationPermission, SchemaNode } from "@wirecat/cli-base/codegen/runtime"
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
import { type ApiCommandInput, apiPathOf, generatedApiCommand } from "./bot/api.js"
import { type HttpApiRequest, httpApiExchange, httpApiRequest, unsendableBody } from "./bot/api-http.js"
import {
  apiJson,
  checkApiBody,
  checkApiParameter,
  graphqlVariables,
  isBlank,
  parseApiJson,
  readApiBody,
  readApiBytes,
  sendsBytes,
} from "./bot/api-input.js"
import { baseContext, outputFor } from "./context.js"
import { NO_EFFECTS } from "./effects.js"
import { itemOf, listOf, renderAnswer } from "./envelope.js"
import { queryTerms, termField, withQuery } from "./list-query.js"
import { terminalAsker } from "./messenger/ask.js"
import { type ConditionalKey, markRenamedPermissionKeys } from "./permission-keys.js"
import {
  manifestBaseUrl,
  nextPage,
  parameterValue,
  type ServiceApiManifest,
  signRequest,
  underBase,
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
  /**
   * What the operations were made from, for the group's help: "its index at /wp-json". Left out, "its OpenAPI
   * document", or "its GraphQL schema" when every operation is GraphQL.
   */
  spec?: string
  /**
   * The values of the server's free variables for this run, such as `{ site }` from the profile's sign-in
   * (`recalledSite`). Read only when a call is sent, so `api list` and `api show` work before sign-in.
   */
  serverVariables?: (command: Command) => Readonly<Record<string, string>>
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
  /** The service's refusal inside a 2xx answer, such as Slack's `{"ok": false}`: see `HttpApiExecutorOptions`. */
  failedAnswer?: (answer: unknown, operation: ManifestOperation) => CliError | undefined
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

const keyOf = (operation: ManifestOperation): PermissionKey => ["api", ...apiPathOf(operation)].join(".")

/** `contacts list`: what follows `api` on the command line. */
const pathOf = (operation: ManifestOperation): string => apiPathOf(operation).join(" ")

/**
 * The key a grouped operation had while `api` was flat, `api.contacts-list`. It checks nothing now: a config that still
 * names it is refused as an unknown key, and the refusal names the new key (WC-CMD-8).
 */
const formerKeyOf = (operation: ManifestOperation): PermissionKey | undefined => {
  const former = `api.${operation.command}`
  return former === keyOf(operation) ? undefined : former
}

const permissionsOf = (operation: ManifestOperation): readonly OperationPermission[] => operation.permissions ?? []

/**
 * Every key a call of the operation may check: `api.<operation>`, the manifest's and the CLI's body keys, each whatever
 * the body holds. For a writer that sends the operation outside the `api` group, so its door is never wider.
 */
export const serviceApiOwnKeys = (
  operation: ManifestOperation,
  bodyPermissions?: ServiceApiPermissionsInput["bodyPermissions"],
): PermissionKey[] => [
  ...new Set([
    keyOf(operation),
    ...permissionsOf(operation).map(({ key }) => key),
    ...(bodyPermissions?.[operation.command] ?? []).map(({ key }) => key),
  ]),
]

/** By its method too: an override may have marked a DELETE as a plain write. */
const destructive = (operation: ManifestOperation) =>
  operation.effect === "destructive" || (operation.binding.kind === "http" && operation.binding.method === "DELETE")

const flagsOf = ({ body = [], query = [] }: OperationPermission) => [...body, ...query]

const valuesOf = ({ values = {} }: OperationPermission) => Object.entries(values)

const unlessOf = ({ unless = {} }: OperationPermission) => Object.entries(unless)

/**
 * Always, unless its flags or values name when; `with status publish or future`, `with archived set`, `with status
 * publish or future or date set, unless status draft or pending`.
 */
const whenOf = (permission: OperationPermission): string | undefined => {
  const flags = flagsOf(permission)
  const values = valuesOf(permission).map(([field, listed]) => `${field} ${listed.join(" or ")}`)
  if (flags.length === 0 && values.length === 0) return undefined
  const unless = unlessOf(permission).map(([field, listed]) => `${field} ${listed.join(" or ")}`)
  return `with ${[...values, ...(flags.length > 0 ? [`${flags.join(" or ")} set`] : [])].join(" or ")}${
    unless.length > 0 && flags.length > 0 ? `, unless ${unless.join(" or ")}` : ""
  }`
}

/** A body field or query parameter holding one of the values: WordPress publishes from either. */
const holds = (value: unknown, listed: readonly string[]) => typeof value === "string" && listed.includes(value)

/** A flag counts unless it is absent or plainly false: a service may read `1` or `True` as true. */
const set = (value: unknown) => value !== undefined && value !== null && value !== false && value !== "false"

/** Whether a manifest key applies to this call: always, or when one of its flags is set or a field holds a value. */
const applies = (permission: OperationPermission, body: unknown, input: ApiCommandInput): boolean => {
  const sends = ([field, listed]: [string, readonly string[]]) =>
    (isObject(body) && holds(body[field], listed)) || holds(input.query[field], listed)
  // Beside a value, a field is another door to the same change and counts once sent at all: WordPress resets a `date`
  // sent as null to now, which publishes a scheduled post. Either place, as WordPress merges the query with the body.
  const sent = permission.values === undefined ? set : (value: unknown) => value !== undefined
  const flagged = flagsOf(permission).some((name) => (isObject(body) && sent(body[name])) || sent(input.query[name]))
  // `unless` lifts only the flags: WordPress keeps a draft a draft whatever its date, and a call that names no status
  // may move a scheduled post's date into the past, which publishes it.
  return (
    whenOf(permission) === undefined ||
    valuesOf(permission).some(sends) ||
    (flagged && !unlessOf(permission).some(sends))
  )
}

/**
 * The keys one call checks beside `api.<operation>`: the manifest's that apply, and the CLI's from the body.
 * @experimental
 */
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
  for (const operation of input.manifest.operations) {
    checks.set(pathOf(operation), [
      ...permissionsOf(operation).map((permission) => {
        const when = whenOf(permission)
        return when === undefined ? permission.key : { key: permission.key, when }
      }),
      ...(input.bodyPermissions?.[operation.command] ?? []).map(({ key, when }) => ({ key, when })),
    ])
  }
  const keys = [...new Set([...checks.values()].flat().map((one) => (typeof one === "string" ? one : one.key)))]
  return {
    extra: keys,
    alsoChecks: (path) => (path[0] === "api" ? (checks.get(path.slice(1).join(" ")) ?? []) : []),
    defaults: {
      ...Object.fromEntries(keys.map((key) => [key, "ask" as const])),
      ...Object.fromEntries(
        input.manifest.operations.filter(destructive).map((operation) => [keyOf(operation), "ask" as const]),
      ),
    },
  }
}

const rowOf = (operation: ManifestOperation) => ({
  command: pathOf(operation),
  group: apiPathOf(operation).length > 1 ? apiPathOf(operation)[0] : null,
  method:
    operation.binding.kind === "http" ? operation.binding.method : operation.binding.kind === "graphql" ? "POST" : "",
  path:
    operation.binding.kind === "http"
      ? operation.binding.path
      : operation.binding.kind === "graphql"
        ? `${operation.binding.operation} ${operation.binding.field}`
        : "",
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
/**
 * What the `api` group and `serviceApiWriter` share, so a write from code passes the very guard a command's does: the
 * offered operations, the server, the sign-in, the levels, and the guarded send.
 */
const serviceApiCore = (options: ServiceApiOptions) => {
  const { app, configuration, manifest } = options
  const { offered: operations, left } = serviceApiOperations(manifest)
  // Without variables the server is known now, and a CLI built against a manifest it cannot reach fails at once.
  if (!options.serverVariables) manifestBaseUrl(manifest, options.baseUrl)
  const baseUrlOf = (command: Command) => manifestBaseUrl(manifest, options.baseUrl, options.serverVariables?.(command))
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
  const exchange = httpApiExchange({
    service: options.service,
    fetch: options.fetch,
    ...(options.failure ? { failure: options.failure } : {}),
    ...(options.failedAnswer ? { failedAnswer: options.failedAnswer } : {}),
  })

  const operationOf = (name: string): ManifestOperation => {
    const named = (one: ManifestOperation) => pathOf(one) === name || one.command === name || one.id === name
    const found = operations.find(named)
    if (found) return found
    const id = manifest.operations.find(named)?.id ?? name
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
    const baseUrl = baseUrlOf(command)
    if (!underBase(request.url, baseUrl))
      throw new CliError("validation_error", `${operation.command} would leave ${baseUrl}`, { sent: false })
    await signRequest(manifest, operation, request, token && (() => token(command)))
    // A site's sign-in follows no redirect: the host is shared with other sites, and only its path tells them apart.
    if (options.serverVariables) request.redirect = "manual"
    for (const [name, value] of Object.entries(options.headers?.(command, operation) ?? {}))
      request.headers.set(name, value)
    return request
  }

  // `own` is the call's own key (`api.<operation>`), asked with the others when the caller confirmed some.
  const guardOf = (
    command: Command,
    extra: readonly PermissionKey[],
    confirmed: readonly PermissionKey[] = [],
    own?: PermissionKey,
  ) => {
    const { settings, env, renderer } = baseContext(command, configuration.resolveSettings)
    const levelOf = (key: PermissionKey) => levelFor(settings.permissions, key, defaults).level
    const asker = terminalAsker(command)
    return keyedGuard(
      (ask) =>
        guardFor(
          app,
          { ...settings, sendsPerHour: Number.MAX_SAFE_INTEGER, permissionDefaults: defaults },
          renderer.warn,
          env,
          ask,
        ),
      confirmed.length === 0
        ? asker
        : async (_key, asked) => {
            // A caller that already asked about a key in this run is not asked again; `deny` and `readonly` still
            // stop it.
            const asking = [...(own ? [own] : []), ...extra].filter(
              (key) => levelOf(key) === "ask" && !confirmed.includes(key),
            )
            if (asking.length > 0) await asker(asking.join(" and "), asked)
          },
      levelOf,
      extra,
    )
  }

  /**
   * A read whose keys all allow it is sent as a read, `--all` included; `deny` refuses it here, and `ask` makes it ask
   * as a write does. So a CLI can put its CRM command's read key (`people.list`) on the raw read.
   */
  const readsFreely = (command: Command, operation: ManifestOperation, extra: readonly PermissionKey[]) => {
    if (operation.effect !== "read") return false
    if (extra.length === 0) return true
    guardOf(command, extra).refuse({ chatId: null, kind: "edit", key: keyOf(operation), operationId: newOperationId() })
    const { settings } = baseContext(command, configuration.resolveSettings)
    return extra.every((key) => levelFor(settings.permissions, key, defaults).level !== "ask")
  }

  const write = async (
    command: Command,
    operation: ManifestOperation,
    extra: readonly PermissionKey[],
    request: HttpApiRequest,
    confirmed: readonly PermissionKey[] = [],
  ) => {
    const { run } = baseContext(command, configuration.resolveSettings)
    const operationId = newOperationId()
    const guard = guardOf(command, extra, confirmed, keyOf(operation))
    const guarded = { chatId: null, kind: "edit" as const, key: keyOf(operation), operationId }
    guard.refuse(guarded)
    try {
      const result = await guardedWrite(guard, guarded, () =>
        run(async () => (await exchange(command, operation, request)).answer),
      )
      return { operation_id: operationId, result }
    } catch (error) {
      if (isCliError(error) && error.code === "outcome_unknown")
        throw new CliError("outcome_unknown", error.message, { ...error.details, operation_id: operationId })
      throw error
    }
  }

  /**
   * The refusal `execute` would give, before the body is read: a `deny` stops a call whatever its input, and a missing
   * body must not answer `validation_error` in its place. Only the keys known without the body; the rest wait for
   * `execute`.
   */
  const refuseBeforeBody = (command: Command, operation: ManifestOperation) => {
    const extra = permissionsOf(operation)
      .filter((permission) => whenOf(permission) === undefined)
      .map(({ key }) => key)
    if (operation.effect === "read" && extra.length === 0) return
    guardOf(command, extra).refuse({ chatId: null, kind: "edit", key: keyOf(operation), operationId: newOperationId() })
  }

  return {
    operations,
    left,
    baseUrlOf,
    defaults,
    exchange,
    operationOf,
    readsFreely,
    refuseBeforeBody,
    signed,
    write,
  }
}

export const serviceApiCommand = (options: ServiceApiOptions): Command => {
  const { app, configuration, manifest } = options
  const { operations, baseUrlOf, exchange, operationOf, readsFreely, refuseBeforeBody, signed, write } =
    serviceApiCore(options)
  const send = async (command: Command, operation: ManifestOperation, request: HttpApiRequest) =>
    (await exchange(command, operation, request)).answer
  let schemas: Readonly<Record<string, v.GenericSchema>> | undefined
  const loaded = () => {
    if (!schemas) throw new CliError("configuration_error", "the api schemas were not loaded before the command ran")
    return schemas
  }
  const load = async () => {
    schemas ??= await options.schemas()
  }
  /** Every page, in one run; a next page outside the server's address is never sent the sign-in. */
  const allPages = async (command: Command, operation: ManifestOperation, input: ApiCommandInput) => {
    const pagination = operation.pagination as NonNullable<ManifestOperation["pagination"]>
    // Services number pages from 0 or from 1, and the manifest says which only where the source did.
    if (
      pagination.style === "page" &&
      pagination.start === undefined &&
      parameterValue(input, pagination.page) === undefined
    )
      throw new CliError(
        "validation_error",
        `--all on ${operation.command} needs the first page: give --${pagination.page.name} 0 or 1, as ${options.service} counts`,
      )
    const items: unknown[] = []
    const asked = new Set<string>()
    const baseUrl = baseUrlOf(command)
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
        const { answer, headers } = await exchange(command, operation, request)
        const step = nextPage(pagination, call, answer, headers)
        for (const item of step.items) items.push(item)
        if (!step.next) return
        if ("url" in step.next) {
          url = new URL(step.next.url, request.url)
          if (!underBase(url, baseUrl))
            throw new CliError("invalid_response", `${options.service} pointed the next page outside ${baseUrl}`)
        } else call = step.next.input
      }
    })
    renderAnswer(
      command,
      outputFor(command),
      listOf(`api ${pathOf(operation)}`, { items, limit: items.length, has_more: false }),
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
    before: refuseBeforeBody,
    checkBody: (operation, text) => checkApiBody(operation, text, loaded()),
    readBody: (command, body) => {
      if (body.bodyFile !== undefined) refuseOwnFiles(command, body.bodyFile)
      return readApiBody(body)
    },
    readBytes: (command, path) => {
      refuseOwnFiles(command, path)
      return readApiBytes(path)
    },
    configure: (command, operation) => {
      if (operation.pagination && !operation.parameters.some(({ name }) => name === "all"))
        command.option("--all", "read every page, as the API pages it")
      command.hook("preAction", load)
    },
    execute: async (command, operation, input) => {
      const extra = serviceApiKeys(options, operation, input)
      const read = readsFreely(command, operation, extra)
      if (operation.pagination && command.opts<{ all?: unknown }>().all === true) {
        if (!read)
          throw new CliError(
            "validation_error",
            `--all reads only; this call of ${operation.command} is guarded by ${extra.join(", ") || "its write"}`,
          )
        return allPages(command, operation, input)
      }
      const request = await signed(command, operation, httpApiRequest(operation, input, baseUrlOf(command)))
      const answer = read
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
    examples: [
      `${app.command} api show ${operations[0] ? JSON.stringify(pathOf(operations[0])) : "<operation>"} --json`,
    ],
  })
    .description(`show one operation's parameters and request schema, without calling ${options.service}`)
    .argument("<operation>", "the operation as api list prints it (quoted), its old name, or its operation id")
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

  const graphql = operations.length > 0 && operations.every((one) => one.binding.kind === "graphql")
  const described = options.spec ?? (graphql ? "its GraphQL schema" : "its OpenAPI document")
  const group = annotate(new Command("api"), { effects: NO_EFFECTS }).description(
    `the raw ${options.service} API, one command per operation of ${described}`,
  )
  group.addCommand(list).addCommand(show)
  for (const child of [...generated.commands]) group.addCommand(child)
  markRenamedPermissionKeys(
    group,
    new Map(
      manifest.operations.flatMap((operation) => {
        const former = formerKeyOf(operation)
        return former ? [[former, keyOf(operation)] as const] : []
      }),
    ),
  )
  return group
}

/** One write of a manifest's operation from code, such as a content command's publish. */
export type ServiceApiWrite = (
  command: Command,
  operation: string,
  input: ApiCommandInput,
  options?: {
    /** Keys the caller already asked about in this run: not asked again, but a `deny` or `readonly` still stops them. */
    confirmed?: readonly PermissionKey[]
  },
) => Promise<{ operation_id: string; result: unknown }>

// Code may pass a number, a boolean or a list where a person types text; the check reads the text it stands for.
const flagText = (raw: unknown): string => (Array.isArray(raw) ? raw.join(",") : String(raw))

/** The body as the command checks it: an upload and an rpc call as given, GraphQL's flags joined to its variables. */
const writerBody = (
  operation: ManifestOperation,
  input: ApiCommandInput,
  schemas: Readonly<Record<string, v.GenericSchema>>,
): ApiCommandInput => {
  if (sendsBytes(operation) || operation.binding.kind === "rpc") return input
  const graphql = operation.binding.kind === "graphql"
  const given = graphql ? apiJson(graphqlVariables(operation, input.body, input.fields ?? {})) : input.body
  const body = checkApiBody(operation, given, schemas)
  return { ...input, ...(graphql ? { fields: {} } : {}), ...(body === undefined ? {} : { body }) }
}

/**
 * The `api` group's write path for code that is not one of its commands: the same keys (`api.<operation>` and each
 * manifest key the call sets off, as `posts.publish`), levels, question and journal line, so a writer is never a
 * looser door than the command. `command` is the one running, which carries the profile and says whether a terminal
 * can be asked. A read that no key guards goes through `serviceApiCall`.
 */
export const serviceApiWriter = (options: ServiceApiOptions): ServiceApiWrite => {
  const { baseUrlOf, operationOf, signed, write } = serviceApiCore(options)
  return async (command, name, input, { confirmed } = {}) => {
    const operation = operationOf(name)
    // The api group offers only declared parameters; code must not reach further, as WordPress's `_method` turns a
    // write into a delete that no delete key guards.
    const undeclared = Object.keys(input.query).filter(
      (one) => !operation.parameters.some((parameter) => parameter.in === "query" && parameter.name === one),
    )
    const overriding = Object.keys(input.headers ?? {}).filter(
      (one) =>
        !operation.parameters.some(
          (parameter) => parameter.in === "header" && parameter.name.toLowerCase() === one.toLowerCase(),
        ),
    )
    if (undeclared.length > 0 || overriding.length > 0)
      throw new CliError(
        "configuration_error",
        `${operation.command} does not take ${[...undeclared, ...overriding].join(", ")}`,
        { sent: false },
      )
    const extra = serviceApiKeys(options, operation, input)
    if (operation.effect === "read" && extra.length === 0)
      throw new CliError("configuration_error", `${operation.command} is a read; send it with serviceApiCall`)
    // The checks the command runs on what a person typed, so code sends nothing a person could not.
    const schemas = await options.schemas()
    const headers = Object.entries(input.headers ?? {})
    for (const parameter of operation.parameters) {
      const raw =
        parameter.in === "header"
          ? headers.find(([one]) => one.toLowerCase() === parameter.name.toLowerCase())?.[1]
          : parameter.in === "query" || parameter.in === "path"
            ? input[parameter.in][parameter.name]
            : undefined
      if (parameter.required && raw !== undefined && isBlank(flagText(raw)))
        throw new CliError("validation_error", `${parameter.name} of ${operation.command} is empty`, { sent: false })
      const problem =
        raw === undefined ? undefined : checkApiParameter(parameter.name, parameter.schema, flagText(raw), schemas)
      if (problem) throw new CliError("validation_error", problem)
    }
    const request = await signed(
      command,
      operation,
      httpApiRequest(operation, writerBody(operation, input, schemas), baseUrlOf(command)),
    )
    return write(command, operation, extra, request, confirmed)
  }
}
