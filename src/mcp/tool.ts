import type { CallToolResult, ServerContext, ToolAnnotations } from "@modelcontextprotocol/server"
import { toJsonSchema } from "@valibot/to-json-schema"
import { CliError, errorCodes, errorObjectOf, type KeyringStore, mcpErrorResult } from "@wirecat/cli-base"
import {
  type Effects,
  type ErrorObject,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  type StepInput,
  traceIdOf,
} from "@wirecat/cli-base/standards"
import * as v from "valibot"
import type { AISettings } from "../analysis/settings.js"
import { judgedEffects, LOCAL_WRITE, REMOTE_WRITE, refuseStoreChange } from "../cli/effects.js"
import { judgedAnswer, sealed } from "../cli/envelope.js"
import { DEFAULT_OUTPUT_BYTES } from "../cli/execution.js"
import { MAX_BUFFERED_INPUT } from "../cli/input-policy.js"
import type { Messenger } from "../cli/messenger/context.js"
import { refuseLacking } from "../cli/messenger/lacks.js"
import type { Settings } from "../cli/settings.js"
import type { WarmEmbedders } from "../embeddings/embed.js"
import { ENTITIES, type EntityName } from "../entities/index.js"
import { type AppErrors, failureContext } from "../errors/reasons.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import { startRecording } from "../runs/recording.js"
import { newRunId } from "../runs/run.js"
import { keepsSuccess, type RunCaller, runContextOf } from "../runs/run-context.js"
import { inRun } from "../runs/scope.js"
import type { SendGuard } from "../sends/guard.js"
import { keyForCommand, levelFor, type PermissionKey, readKeysForCommand } from "../sends/permissions.js"
import { onlineDeps, storeModeDeps } from "../services/deps.js"
import { type Services, servicesFor } from "../services/index.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { type CallerSource, callerOf, currentCaller, withCaller } from "./caller.js"
import type { MessengerSession } from "./session.js"
import { agentJson } from "./text.js"

export const limit = v.optional(
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100), v.description("how many")),
)
export const page = v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.description("which page, from 1")))
/** Opaque: another messenger's ids need not be digits. */
export const message = v.pipe(
  v.string(),
  v.maxLength(256),
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  v.regex(/^[^\s\x00-\x1F\x7F-\x9F]+$/, "a message id has no spaces or control characters"),
  v.description("message id"),
)

export const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

export { UNTRUSTED, UNTRUSTED_NEUTRAL } from "./text.js"

type Input = v.ObjectSchema<v.ObjectEntries, undefined> | v.StrictObjectSchema<v.ObjectEntries, undefined>

/** Reaches the session's connection only when called, so a read answered from the store never opens it. */
export type Connect = <T>(work: (adapter: MessengerAdapter) => Promise<T>) => Promise<T>

/** What a tool may need beyond its arguments. */
export interface Defaults {
  spawnJob?: import("../services/backfill-jobs.js").SpawnJob
  syncAllowed?: boolean
  signal?: AbortSignal
  /** Drop a held connection before synchronous local inference. */
  release?: () => Promise<void>
  limit: number
  guard: SendGuard
  /** The profile's own entries, for a tool reading a setting of its own — `transcribeWith`. */
  settings: Pick<Settings, "configured" | "shared" | "profile"> &
    Partial<
      Pick<
        Settings,
        | "permissions"
        | "searchCatchUp"
        | "pictureSearch"
        | "searchReranker"
        | "offline"
        | "record"
        | "keepFailedRuns"
        | "keepRunsForDays"
        | "keepSuccessfulRunsForDays"
        | "runsSizeLimitMb"
      >
    > &
    AISettings
  env: NodeJS.ProcessEnv
  keyring?: KeyringStore
  /** The server's open models, kept between `search_conversations` calls. */
  embedders?: WarmEmbedders
  /** False when recording was explicitly disabled; stored search tools keep no query history. */
  history?: boolean
}

interface Tool<S extends Input> {
  title: string
  description: string
  input: S
  annotations: ToolAnnotations
  /** What it touches, where its hints cannot say: a read of the messenger kept in the store is not a write there. */
  effects?: Effects
  _meta?: Record<string, unknown>
  /** Writes what the owner keeps, as its command (`isStoreChange`): `<PREFIX>_READ_ONLY` refuses it. */
  changesStore?: true
  /** The CLI command it answers as, where its name does not spell it: `chats send-as`. Its level is read from it. */
  command?: string
  /** A permission key other than its command's. */
  key?: PermissionKey | null
  /** No CLI command answers it — a photo handed to the model, a build-then-embed in one call — so no tree drops it. */
  agentOnly?: true
  /** A host-owned entry with its own connection and confirmation lifecycle. */
  custom?: (args: v.InferOutput<S>, defaults: Defaults, ctx: ServerContext) => Promise<object>
  /** Refuses arguments the schema cannot judge before the store or the connection opens, as its command does. */
  check?: (args: v.InferOutput<S>) => void
  /** Neither the store nor the connection: answers from what this process already knows. */
  local?: (args: v.InferOutput<S>, defaults: Defaults) => Promise<object>
  /** Over the session's connection. */
  online?: (adapter: MessengerAdapter, args: v.InferOutput<S>, defaults: Defaults) => Promise<object>
  outputLimit?: (args: Record<string, unknown>, defaults: Defaults) => number
  /** The entity it answers with, once it answers in the envelope: its `outputSchema` is generated from it. */
  output?: { entity: EntityName; list: boolean }
  storedWhen?: (args: v.InferOutput<S>) => boolean
  /** Uses the local store; an explicit network option may use the retained session. */
  stored?: (
    store: MessageStore,
    account: AccountKey,
    args: v.InferOutput<S>,
    defaults: Defaults,
    connect?: Connect,
  ) => Promise<object>
  /**
   * Over the services, as its command: from the store when the messenger's history is kept there
   * (`Messenger.history`), over the session's connection otherwise. A read only.
   */
  served?: (services: Services, args: v.InferOutput<S>, defaults: Defaults, connect: Connect) => Promise<object>
}

export type AnyTool = Omit<Tool<Input>, "online" | "stored" | "served" | "local" | "check"> & {
  check?: (args: Record<string, unknown>) => void
  local?: (args: Record<string, unknown>, defaults: Defaults) => Promise<object>
  online?: (adapter: MessengerAdapter, args: Record<string, unknown>, defaults: Defaults) => Promise<object>
  stored?: (
    store: MessageStore,
    account: AccountKey,
    args: Record<string, unknown>,
    defaults: Defaults,
    connect?: Connect,
  ) => Promise<object>
  served?: (services: Services, args: Record<string, unknown>, defaults: Defaults, connect: Connect) => Promise<object>
}

/** Typed where it is written; erased here because the SDK checks the arguments against `input` first. */
export const tool = <S extends Input>(definition: Tool<S>): AnyTool => definition as unknown as AnyTool

export const paging = (args: { limit?: number; page?: number }, defaults: Defaults) => {
  const size = args.limit ?? defaults.limit
  const number = args.page ?? 1
  return { size, number, window: { limit: size, offset: (number - 1) * size } }
}

/** A `chat` argument in this messenger's words. */
export const chatOf = (messenger: Messenger) =>
  v.pipe(v.string(), v.minLength(1), v.description(messenger.chatArgument))

/** `Telegram`, or the command when the messenger has no name of its own. */
export const nameOf = (messenger: Messenger): string => messenger.name ?? messenger.app.command

export interface Registration {
  command: string
  messenger: Messenger
  session: Pick<MessengerSession, "use">
  withStore: <T>(
    work: (store: MessageStore, account: AccountKey) => Promise<T>,
    options: { name: string },
  ) => Promise<T>
  /** A host may bind its account-scoped store and service overrides to the held connection. */
  withServices?: <T>(
    work: (services: Services, connect: Connect) => Promise<T>,
    options: { name: string },
  ) => Promise<T>
  defaults: Defaults
  /** A host's permission scope encloses local reads and online calls alike. */
  around?: <T>(name: string, definition: AnyTool, work: () => Promise<T>) => Promise<T>
  /** Keeps one audit row per call — tool, tier, outcome, times — never the arguments or the answer. */
  log?: (call: ToolCall, caller: RunCaller | undefined) => Promise<void>
  /** The CLI's commands, by which an answer's next steps are judged safe to run unasked. */
  targets?: NonNullable<StepInput["targets"]>
  /** How a call's caller is worked out on this connection (`callerOf`); without it the environment's agent is kept. */
  callers?: CallerSource
}

export type ToolTier = "read" | "draft" | "write-private" | "write-public" | "destructive" | "admin"

export interface ToolCall {
  tool: string
  tier: ToolTier
  status: "ok" | "refused" | "failed"
  /** The failure's code, e.g. `permission_error`; never its message. */
  error?: string
  startedAt: number
  finishedAt: number
}

/**
 * How far a tool reaches, read from what it declares: a read; an admin tool; one that removes or bans; a
 * draft; a write only the owner sees (marking read, tagging, notes, a pin that may be quiet); or a write others see.
 */
export const tierOf = (
  key: string,
  definition: Pick<AnyTool, "annotations">,
  messenger?: Pick<Messenger, "quietPins">,
): ToolTier => {
  if (definition.annotations.readOnlyHint === true) return "read"
  if (/^admin|_admin/.test(key)) return "admin"
  if (/delete|ban|kick|remove|purge|block/.test(key)) return "destructive"
  if (/draft/.test(key)) return "draft"
  if (key === "messages_pin" && messenger?.quietPins === false) return "write-public"
  if (/mark_read|mark_unread|read_mark|archive|mute|pin|tag|note|label|folder|alias|save|_(un)?star$/.test(key))
    return "write-private"
  return "write-public"
}

/** A tool's effects: declared, or read from its hints — an open-world tool that is not read-only writes there. */
export const effectsOf = (definition: Pick<AnyTool, "annotations" | "effects">): Effects => {
  if (definition.effects) return definition.effects
  const { readOnlyHint, openWorldHint } = definition.annotations
  if (readOnlyHint === true) return { remote: openWorldHint === false ? "none" : "read", local: "read" }
  return openWorldHint === false ? LOCAL_WRITE : REMOTE_WRITE
}

/** The audit outcome of an answer: a profile's refusal apart from a failure. */
export const outcomeOf = (result: CallToolResult): Pick<ToolCall, "status" | "error"> => {
  if (!result.isError) return { status: "ok" }
  const code = (result.structuredContent as { error?: { code?: unknown } } | undefined)?.error?.code
  const error = typeof code === "string" ? code : "generic_failure"
  return { status: error === "permission_error" ? "refused" : "failed", error }
}

/** The CLI command a tool answers as: declared, or its name read as a command path. */
export const commandOf = (name: string, definition: Pick<AnyTool, "command">): string =>
  definition.command ?? name.replaceAll("_", " ")

/** The key a tool's level is read from: its own, or its command's. */
export const toolKey = (
  name: string,
  definition: Pick<AnyTool, "key" | "command">,
): PermissionKey | null | undefined =>
  definition.key !== undefined ? definition.key : keyForCommand(commandOf(name, definition).split(" "))

/**
 * The arguments an entry takes, refusing any other: a loose object drops an argument it does not know, so a
 * misspelled filter runs unfiltered. Without the sync options when the profile does not allow syncing first.
 */
export const inputOf = (definition: AnyTool, syncAllowed: boolean): Input =>
  v.strictObject(
    syncAllowed || !("sync_first" in definition.input.entries)
      ? definition.input.entries
      : Object.fromEntries(
          Object.entries(definition.input.entries).filter(
            ([name]) => !["sync_first", "sync_time", "max_chats", "max_messages"].includes(name),
          ),
        ),
  )

/** Runs one definition with arguments already checked against its input, as its tool would. */
export type RunEntry = (
  key: string,
  definition: AnyTool,
  args: Record<string, unknown>,
  ctx: ServerContext,
) => Promise<CallToolResult>

/** Whether a profile may sync before answering this entry. */
export const syncAllowedFor = (key: string, defaults: Defaults): boolean => {
  const permissions = defaults.settings.permissions ?? {}
  const shared = defaults.syncAllowed ?? levelFor(permissions, "messages.sync-first").level === "allow"
  return (
    shared &&
    (!key.startsWith("stats_") || levelFor(permissions, `${key.replaceAll("_", ".")}.sync-first`).level === "allow")
  )
}

export const entryRunner = (registration: Registration): RunEntry => {
  const run = callRunner(registration)
  const { log } = registration
  return async (key, definition, args, ctx) => {
    const startedAt = Date.now()
    const command = `mcp ${commandOf(key, definition)}`
    const traceId = traceIdOf(ctx?.mcpReq?._meta?.traceparent)
    const app = registration.messenger?.app
    const caller = registration.callers ? callerOf(ctx, key, registration.callers) : currentCaller()
    const env = registration.defaults.env ?? process.env
    const settings = registration.defaults.settings
    const recording =
      key !== "runs_search" && settings.keepFailedRuns !== false && app?.appName
        ? startRecording({
            app,
            command,
            ...(settings.profile === undefined ? {} : { profile: settings.profile }),
            env,
            record: keepsSuccess({ record: settings.record ?? true, fromFlag: false, env, caller }),
            keepFailed: true,
            trace: false,
            format: "json",
            context: runContextOf({ bin: app.command, command, env, caller }),
            ...(settings.keepRunsForDays === undefined ? {} : { keepDays: settings.keepRunsForDays }),
            ...(settings.keepSuccessfulRunsForDays === undefined
              ? {}
              : { keepSuccessDays: settings.keepSuccessfulRunsForDays }),
            ...(settings.runsSizeLimitMb === undefined ? {} : { maxBytes: settings.runsSizeLimitMb * 1024 * 1024 }),
            ...(traceId === undefined ? {} : { traceId }),
          })
        : undefined
    const profile = registration.defaults.settings.profile
    const scope = {
      runId: recording?.runId ?? newRunId(new Date(startedAt), command),
      command,
      startedAt,
      ...(profile === undefined ? {} : { profile }),
      ...(traceId === undefined ? {} : { traceId }),
      ...(recording ? { events: recording.events } : {}),
    }
    const work = () =>
      inRun(scope, () => {
        const input = inputOf(definition, syncAllowedFor(key, registration.defaults))
        const parsed = v.safeParse(input, args)
        return parsed.success
          ? run(key, definition, parsed.output, ctx)
          : failed(
              new CliError("validation_error", `${commandOf(key, definition)}: ${v.summarize(parsed.issues)}`, {
                arguments: toJsonSchema(input),
              }),
              app?.errors,
            )
      })
    // The connection a session opens for this call is recorded under the same caller.
    const result = await (caller ? withCaller(caller, work) : work())
    if (recording) {
      if (result.isError) {
        const error = (result.structuredContent as { error?: { code?: string; message?: string } } | undefined)?.error
        const code =
          error?.code && (errorCodes as readonly string[]).includes(error.code)
            ? (error.code as ConstructorParameters<typeof CliError>[0])
            : undefined
        await recording
          .fail(code ? new CliError(code, "MCP operation failed") : new Error("MCP operation failed"))
          .catch(() => undefined)
      } else await recording.succeed(result.structuredContent).catch(() => undefined)
    }
    // The audit row must not cost the agent its answer: a store that cannot be written is not this call's failure.
    await log?.(
      {
        tool: key,
        tier: tierOf(key, definition, registration.messenger),
        ...outcomeOf(result),
        startedAt,
        finishedAt: Date.now(),
      },
      caller,
    )?.catch(() => undefined)
    return result
  }
}

const callRunner = ({
  messenger,
  session,
  withStore,
  withServices,
  defaults,
  around,
  targets,
}: Registration): RunEntry => {
  const where = {
    profile: defaults.settings.profile,
    env: defaults.env,
    pictures: defaults.settings.pictureSearch,
    reranker: defaults.settings.searchReranker,
  }
  return async (key, definition, args, ctx) => {
    const path = commandOf(key, definition).split(" ")
    const run = `mcp ${path.join(" ")}`
    try {
      const execute = async () => {
        const syncAllowed = syncAllowedFor(key, defaults)
        if (Buffer.byteLength(JSON.stringify(args)) > MAX_BUFFERED_INPUT)
          throw new CliError("validation_error", "tool arguments exceed the buffered input limit", {
            reason: "input.too-large",
            max_bytes: MAX_BUFFERED_INPUT,
            retryable: false,
          })
        definition.check?.(args)
        if (definition.changesStore) refuseStoreChange(messenger.app, defaults.env)
        refuseLacking(messenger, path)
        for (const permission of readKeysForCommand(path)) {
          if (levelFor(defaults.settings.permissions ?? {}, permission).level === "deny")
            throw new CliError("permission_error", `profile denies ${permission}`, { permission })
        }
        if (args.sync_first && !syncAllowed)
          throw new CliError("permission_error", "messages.sync-first is not allowed by this profile")
        if (definition.custom) {
          const result = await definition.custom(args, { ...defaults, signal: ctx.mcpReq.signal }, ctx)
          return answered(result, definition.outputLimit?.(args, defaults), targets)
        }
        if (definition.local)
          return answered(await definition.local(args, defaults), definition.outputLimit?.(args, defaults), targets)
        const { online, stored: local, served } = definition
        const stored = local && (!definition.storedWhen || definition.storedWhen(args)) ? local : undefined
        const result = stored
          ? await withStore(
              (store, account) =>
                stored(store, account, args, { ...defaults, signal: ctx.mcpReq.signal }, (work) =>
                  session.use(run, work),
                ),
              {
                name: run,
              },
            )
          : served && withServices
            ? await withServices((services, connect) => served(services, args, defaults, connect), { name: run })
            : served && messenger.history === "store"
              ? await withStore(
                  (store, account) =>
                    served(
                      servicesFor({
                        ...storeModeDeps(messenger, store, account, defaults.guard),
                        ...where,
                        embedders: defaults.embedders,
                      }),
                      args,
                      defaults,
                      (work) =>
                        session.use(run, async (adapter, release) => {
                          try {
                            return await work(adapter)
                          } finally {
                            await release()
                          }
                        }),
                    ),
                  { name: run },
                )
              : served
                ? await session.use(run, (adapter, release) =>
                    served(servicesFor(onlineDeps(messenger, adapter, defaults.guard, where)), args, defaults, (work) =>
                      (async () => {
                        try {
                          return await work(adapter)
                        } finally {
                          await release()
                        }
                      })(),
                    ),
                  )
                : await session.use(run, (adapter, release) =>
                    (online as NonNullable<typeof online>)(adapter, args, { ...defaults, release }),
                  )
        return answered(result, definition.outputLimit?.(args, defaults), targets)
      }
      return around ? await around(key, definition, execute) : await execute()
    } catch (error) {
      return failed(error, messenger?.app?.errors, effectsOf(definition))
    }
  }
}

/** The envelope a tool's answer is checked against: generated from its entity, or any object until it declares one. */
export const outputSchemaOf = (definition: Pick<AnyTool, "output">): v.GenericSchema => {
  if (!definition.output) return v.looseObject({})
  const entity = ENTITIES[definition.output.entity] as v.GenericSchema
  return definition.output.list ? listEnvelopeSchema(entity) : itemEnvelopeSchema(entity)
}

/** An answer that is a picture, not JSON: it goes to the client as `image` content, with `about` as text. */
export class Picture {
  constructor(
    readonly bytes: Uint8Array,
    readonly mimeType: string,
    readonly about: object,
  ) {}
}

export class BinaryResource {
  constructor(
    readonly base64: string,
    readonly mimeType: string,
    readonly uri: string,
    readonly about: object,
  ) {}
}

export const answered = (
  answer: object,
  maxBytes = DEFAULT_OUTPUT_BYTES,
  targets?: NonNullable<StepInput["targets"]>,
): CallToolResult => {
  const bounded = (result: CallToolResult): CallToolResult => {
    if (maxBytes !== 0 && Buffer.byteLength(JSON.stringify(result)) > maxBytes)
      throw new CliError(
        "invalid_response",
        "tool output exceeds its byte limit — reduce limit or use a narrower request",
        { reason: "output.too-large", max_bytes: maxBytes, retryable: false },
      )
    return result
  }
  if (answer === null || Array.isArray(answer) || typeof answer !== "object")
    throw new CliError("invalid_response", "tool result must be an object", { retryable: false })
  const objectBody = (value: object): Record<string, unknown> => {
    const serialized = JSON.parse(agentJson(value)) as unknown
    if (serialized === null || Array.isArray(serialized) || typeof serialized !== "object")
      throw new CliError("invalid_response", "serialized tool result must be an object", { retryable: false })
    return serialized as Record<string, unknown>
  }
  if (answer instanceof BinaryResource) {
    const about = sealed(answer.about)
    return bounded({
      structuredContent: objectBody(about),
      content: [
        { type: "resource", resource: { uri: answer.uri, mimeType: answer.mimeType, blob: answer.base64 } },
        { type: "text", text: agentJson(about) },
      ],
    })
  }
  if (answer instanceof Picture) {
    const about = sealed(answer.about)
    return bounded({
      structuredContent: objectBody(about),
      content: [
        { type: "image", data: Buffer.from(answer.bytes).toString("base64"), mimeType: answer.mimeType },
        { type: "text", text: agentJson(about) },
      ],
    })
  }
  const body = objectBody(sealed(targets ? judgedAnswer(answer, targets) : answer))
  return bounded({ content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body })
}

/** The same object the CLI prints on stderr, so an agent reads one error shape from both. */
export const failed = (error: unknown, errors?: AppErrors, effects?: Effects): CallToolResult => {
  const judged = judgedEffects(effects)
  const context = { ...failureContext(errors), ...(judged ? { effects: judged } : {}) }
  return mcpErrorResult(JSON.parse(agentJson(errorObjectOf(error, context))) as ErrorObject) as CallToolResult
}

/** An option's name as an MCP argument: `beforeId` is `before_id`. */
export const snakeOf = (key: string): string => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
