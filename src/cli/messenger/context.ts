import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { servingProfiles } from "../../background/lock.js"
import type { AdminRight, GroupSettings } from "../../domain/models.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import type { EventSink } from "../../runs/events.js"
import { FloodMemory, floodPathFor } from "../../sends/flood.js"
import { type Asker, guardFor, type SendGuard } from "../../sends/guard.js"
import { DEFAULT_PACE, type PaceRate, Pacer, pacePathFor } from "../../sends/pace.js"
import {
  assertStatsPermissionsCurrent,
  levelFor,
  type PermissionKey,
  readKeysForCommand,
} from "../../sends/permissions.js"
import { OFFLINE, type ServiceDeps, type ServiceMessenger, type Services, servicesFor } from "../../services/index.js"
import type { OpenRecognizer } from "../../speech/transcribe.js"
import { type AccountKey, type DeletionScope, type MessageStore, openStore } from "../../store/store.js"
import { type BaseContext, baseContext, environmentOf } from "../context.js"
import { knownPermissionKeys, type PermissionKeyOf, unknownPermissionKeys } from "../permission-keys.js"
import type { GlobalFlags, ResolveOptions, Settings } from "../settings.js"
import { recalledAccount, rememberAccount } from "./accounts.js"
import { terminalAsker } from "./ask.js"
import { flooded } from "./flooded.js"
import { observed } from "./observed.js"
import { stored } from "./stored.js"

/** `listen` opens a connection that receives updates — only `watch` asks; the rest stay quiet. */
export interface ConnectOptions {
  listen?: boolean
  /** Fetch what arrived while nothing listened — `serve` only; `watch` starts from now. */
  catchUp?: boolean
  /** The run's diagnostics, for a messenger that reports its own wire below the adapter's calls. */
  events?: EventSink
}

/** What one messenger CLI hands the shared commands. Everything else about it stays in its own code. */
export interface Messenger extends ServiceMessenger {
  /**
   * `"exclusive"`: the messenger allows one connection per account, so while `serve` holds it, every command that
   * reaches the messenger — writes, `watch`, `mcp` — runs inside that serve, through its relay, and never opens a
   * second one. Not on Windows yet. Unset: each command connects on its own.
   */
  connection?: "exclusive"
  /** How fast one profile may ask the messenger, across processes, unless `requests_per_minute` says otherwise. */
  pace?: PaceRate
  resolveSettings: (flags: GlobalFlags, options?: ResolveOptions) => Settings
  /**
   * Opens a connection for the command's profile, or throws a typed error saying how to log in.
   * Called inside `--timeout`; the context tracks and closes what it returns.
   */
  connect: (command: Command, context: BaseContext, options?: ConnectOptions) => Promise<MessengerAdapter>
  /** The help for a `<chat>` argument, in this messenger's words. */
  chatArgument: string
  /** The group settings this messenger has, as `chats update` offers them; every one when unset. */
  groupSettings?: readonly (keyof GroupSettings)[]
  /** Whether `polls create` makes quizzes (`--quiz --correct --solution`); no when unset. */
  pollQuiz?: boolean
  /** How many seconds after sending a poll may close by itself — `polls create --close-time`; none when unset. */
  pollCloseSeconds?: readonly [min: number, max: number]
  /** Whether `polls voters` lists who voted for what; no when unset. */
  pollVoters?: boolean
  /** Whether the messenger has forum topics: `--topic`, `topic:` in `messages list` and the `topics_*` tools; yes when unset. */
  topics?: boolean
  /** Whether `topics show` reads one forum topic; no when unset. */
  topicShow?: boolean
  /** Whether the messenger reads HTML in `--html`; no when unset. */
  html?: boolean
  /** Whether folder ordering is available; yes when unset. */
  folderOrder?: boolean
  /** Whether `chats update --photo` sets a group's photo; no when unset. */
  groupPhoto?: boolean
  /** Whether `chats media` lists a chat's media from the server; no when unset. */
  chatMedia?: boolean
  /** Whether `account privacy show` and `set` read and change the account's privacy; no when unset. */
  privacy?: boolean
  /** Whether `chats mute` and `unmute` exist; no when unset. */
  chatMute?: boolean
  /** Whether `chats delete` and `chats clear` exist; no when unset. */
  chatDeletion?: boolean
  /** Whether `messages press`, `chats start` and `chats app` exist — a bot met on the personal account; no when unset. */
  personalBots?: boolean
  /** Whether `messages send --sticker` sends a sticker; no when unset. `stickers list` is a group a CLI adds itself. */
  stickers?: boolean
  /** Whether shared folders can be joined; yes when unset. */
  folderJoin?: boolean
  /** Whether another invite link can be made — `chats link create`; yes when unset. */
  inviteLinkCreate?: boolean
  /** Whether invite links can be listed; yes when unset. */
  inviteLinkList?: boolean
  /** Whether one invite link can be revoked; yes when unset. */
  inviteLinkRevoke?: boolean
  /** Whether one invite link can be changed — `chats link update`; no when unset. */
  inviteLinkUpdate?: boolean
  /** Whether every pending join request is answered at once — `chats requests accept --all`; yes when unset. */
  joinRequestsAll?: boolean
  /** Whether a channel post can be commented on — `messages send --comment-to`; yes when unset. */
  channelComments?: boolean
  /** Whether people added can be shown the messages from before they came — `members add --history`; yes when unset. */
  addsWithHistory?: boolean
  /** The admin rights this messenger has, as `admins add --can` offers them; every one when unset. */
  adminRights?: readonly AdminRight[]
  /**
   * The account a command names itself, in place of the one its profile remembers: memo has no messenger
   * profile and mounts the local task builders with `--provider --account`.
   */
  accountOf?: (command: Command) => AccountKey | undefined
  /**
   * Whether a stored chat may hold a message the messenger deleted without naming its chat. When
   * unset, the store applies Telegram's rule.
   */
  deletedWithoutChat?: DeletionScope
  /** Whether the messenger computes a chat's statistics for its admins — `stats chats official`; no when unset. */
  officialStats?: boolean
  /** Whether this CLI's background service fetches tracked rosters daily; true when unset. */
  tracksMembers?: boolean
  /** Speech model ids, most suitable first, for `messages transcribe --local`; the first is the default. */
  speechModels?: readonly string[]
  /**
   * The send guard for a command, when the messenger's is not the profile's plain one — max-cli's
   * background server journals what it forwards, so a command over it records only its refusals.
   * `ask`, when given, answers a write at level `ask` instead of the messenger's own prompt: the MCP
   * server has no terminal to ask at.
   */
  guard?: (command: Command, settings: Settings, warn: (message: string) => void, ask?: Asker) => SendGuard
  /** The permission key of one of this CLI's own commands, when `keyForCommand` does not know it. */
  permissionKey?: PermissionKeyOf
  /** The CLI's SKILL.md, which the MCP server also serves as `<command>://skill`. */
  skill?: URL
  /** What only this messenger can say about itself for `doctor`, read from disk — never a secret. */
  diagnose?: (command: Command, context: BaseContext) => Promise<Record<string, unknown>>
}

/**
 * The messenger's connection — or, in a command serve runs for a client, serve's own, borrowed. Every connect
 * goes through here, so a relayed command never opens a second connection.
 */
export const connectFor = (
  command: Command,
  messenger: Pick<Messenger, "connect">,
  base: BaseContext,
  options: ConnectOptions = {},
): Promise<MessengerAdapter> => {
  const { relayed } = environmentOf(command)
  if (!relayed) return messenger.connect(command, base, options)
  if (base.settings.profile !== relayed.profile) {
    return Promise.reject(
      new CliError(
        "permission_error",
        `this serve holds profile ${relayed.profile}; it does not run commands for profile ${base.settings.profile}`,
        { sent: false },
      ),
    )
  }
  return Promise.resolve(relayed.connection())
}

export type ReadConnection = <T>(work: (adapter: MessengerAdapter) => Promise<T>) => Promise<T>

export interface MessengerContext extends BaseContext {
  profile: string
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  /** The local speech recognizer, where a test hands one in. */
  recognizer?: OpenRecognizer
  /** Read-only, the allow-list, the recipient list and the hourly limit — asked before every write, told after. */
  guard: SendGuard
  /**
   * Connects inside `--timeout`, and closes on every path. What the reads answer is saved to the
   * message store, and each call is a run event.
   */
  withMessenger: <T>(work: (messenger: MessengerAdapter) => Promise<T>, options?: ConnectOptions) => Promise<T>
  /** Answers from the message store alone, for `--offline`. Never connects and needs no credentials. */
  withStore: <T>(
    work: (store: MessageStore, account: AccountKey) => Promise<T>,
    options?: { name?: string },
  ) => Promise<T>
  /** The shared use cases, over a connection and a store each opened only if a service asks for it. */
  withServices: <T>(
    work: (services: Services, connect?: ReadConnection) => Promise<T>,
    options?: { name?: string },
  ) => Promise<T>
}

/** Long enough for a local write; a store that hangs must not keep the process alive. */
const SAVES_WAIT_MS = 5_000

/** Whether every save finished within `ms`. Saves never reject: `stored` turns a failure into a warning. */
const settled = async (pending: Set<Promise<void>>, ms: number): Promise<boolean> => {
  if (pending.size === 0) return true
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([Promise.all([...pending]).then(() => true as const), late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A connection as every shared reader sees it: its account remembered, each call a run event, what
 * the reads answer saved to the store. `close` closes the connection and the store it opened. One
 * function, so a command and an MCP tool call save and record exactly alike.
 */
export const connected = (
  connection: MessengerAdapter,
  {
    app,
    provider,
    name,
    deletedWithoutChat,
    pace,
  }: Pick<Messenger, "app" | "provider" | "name" | "deletedWithoutChat" | "pace">,
  { settings, env, renderer }: Pick<BaseContext, "settings" | "env" | "renderer">,
  events: EventSink,
): { adapter: MessengerAdapter; close: () => Promise<void> } => {
  const self = connection.self()
  if (self !== null) rememberAccount(app, settings.profile, self, env)
  const memory = new FloodMemory(floodPathFor(app, settings.profile, env))
  const rate = {
    ...DEFAULT_PACE,
    ...pace,
    ...(settings.requestsPerMinute === undefined ? {} : { perMinute: settings.requestsPerMinute }),
  }
  const pacer = new Pacer(pacePathFor(app, settings.profile, env), rate)
  const adapter = observed(
    flooded(connection, memory, { name: name ?? app.command, warn: renderer.warn, pacer }),
    events,
  )
  let store: Promise<MessageStore | undefined> | undefined
  const pending = new Set<Promise<void>>()
  return {
    adapter:
      self === null
        ? adapter
        : stored(adapter, {
            account: { provider, account: self },
            profile: { app: app.command, name: settings.profile },
            store: () => {
              store ??= openStore({ env, command: app.command })
              return store
            },
            warn: renderer.warn,
            events,
            pending,
            ...(deletedWithoutChat ? { deletedWithoutChat } : {}),
          }),
    close: async () => {
      try {
        await connection.close()
      } finally {
        try {
          if (!(await settled(pending, SAVES_WAIT_MS))) {
            events({ event: "warning", code: "store_not_written", operation: "close" })
            renderer.warn("not saved to the local store: the last messages were still being written at exit")
          }
        } finally {
          if (store) await (await store.catch(() => undefined))?.close()
        }
      }
    },
  }
}

const unrecorded = (messenger: Messenger, profile: string): CliError =>
  new CliError(
    "not_found",
    messenger.history === "store"
      ? `nothing recorded for profile "${profile}" yet — run \`${messenger.app.command} serve\` or ` +
          `\`${messenger.app.command} watch\` once to fill the local store`
      : `nothing recorded for profile "${profile}" yet — run the command once without --offline`,
  )

/** NEED-506 A: without it, an agent cannot tell a quiet chat from a store nothing keeps up to date. */
const warnUnserved = async (
  messenger: Messenger,
  profile: string,
  { env, renderer }: Pick<BaseContext, "env" | "renderer">,
  store: MessageStore,
) => {
  if (servingProfiles(messenger.app, env).includes(profile)) return
  const account = recalledAccount(messenger.app, messenger.provider, profile, env)
  if (!account) return
  const newest = (await store.chats.chatStats(account))
    .map((one) => one.newestAt)
    .reduce<string | null>((latest, at) => (at !== null && (latest === null || at > latest) ? at : latest), null)
  renderer.warn(
    `no \`${messenger.app.command} serve\` keeps profile "${profile}" up to date — ` +
      (newest === null ? "the local store holds no messages yet" : `the newest stored message is from ${newest}`),
  )
}

/** The words of a command below the program, `["messages", "list"]` — the profile word is not one of them. */
const pathOf = (command: Command): string[] => {
  const words: string[] = []
  for (let at: Command | null = command; at?.parent; at = at.parent) words.unshift(at.name())
  return words
}

/** `deny` stops a read too, before anything connects: what the profile may not see is never fetched. */
const refuseDenied = (command: Command, settings: Settings) => {
  assertStatsPermissionsCurrent(pathOf(command), settings.permissions)
  for (const key of readKeysForCommand(pathOf(command))) {
    const { level, key: named } = levelFor(settings.permissions, key)
    if (level !== "deny") continue
    throw new CliError(
      "permission_error",
      `profile ${settings.profile} denies ${key} (permissions.${named} is deny, from the ` +
        `${settings.permissionSources[named ?? ""] ?? "default"})`,
      { permission: key },
    )
  }
}

/**
 * A write to the local store alone. `deny` already stopped the command (`messengerContext`); `readonly`
 * stops this write too. There is no question to put to the owner here, so `ask` refuses rather than
 * writing unasked.
 */
export const refuseLocalWrite = (context: MessengerContext, command: string, permission: PermissionKey): void => {
  const { settings } = context
  const { level, key } = levelFor(settings.permissions, permission)
  if (level === "allow") return
  throw new CliError(
    level === "ask" ? "confirmation_required" : "permission_error",
    `profile ${settings.profile} does not let ${permission} write (permissions.${key} is ${level}, from the ` +
      `${settings.permissionSources[key ?? ""] ?? "default"}); to allow it: ` +
      `${command} ${settings.profile} config set permissions.${permission} allow`,
    { permission },
  )
}

export const messengerContext = (
  command: Command,
  messenger: Messenger,
  resolving: Pick<ResolveOptions, "needsProfile"> = {},
): MessengerContext => {
  const { app, provider } = messenger
  const base = baseContext(command, (flags, options) => messenger.resolveSettings(flags, { ...options, ...resolving }))
  const { profile } = base.settings
  refuseDenied(command, base.settings)
  for (const key of unknownPermissionKeys(
    base.settings.permissions,
    knownPermissionKeys(command, messenger.permissionKey),
  )) {
    base.renderer.warn(`permissions.${key} names no command and does nothing — \`config unset permissions.${key}\``)
  }
  // Read when warning, not now: serve swaps the renderer's methods for log records after this.
  const warn = (text: string) => base.renderer.warn(text)
  const accountFor = (): AccountKey => {
    const account = messenger.accountOf?.(command) ?? recalledAccount(app, provider, profile, base.env)
    if (!account) throw unrecorded(messenger, profile)
    return account
  }
  const guard =
    messenger.guard?.(command, base.settings, warn) ??
    guardFor(app, base.settings, warn, base.env, terminalAsker(command))

  return {
    ...base,
    profile,
    stdin: environmentOf(command).stdin ?? process.stdin,
    ...(environmentOf(command).recognizer ? { recognizer: environmentOf(command).recognizer } : {}),
    guard,
    withMessenger: (work, options = {}) =>
      base.run(
        async (events) => {
          if (base.settings.offline) throw new CliError("validation_error", OFFLINE)
          const connection = await connectFor(command, messenger, base, { ...options, events })
          base.track(connection)
          const { adapter, close } = connected(connection, messenger, base, events)
          try {
            return await work(adapter)
          } finally {
            await close()
          }
        },
        { unbounded: options.listen === true },
      ),
    withStore: (work, { name } = {}) =>
      base.run(
        async () => {
          const account = accountFor()
          const store = await openStore({ env: base.env, command: app.command })
          try {
            return await work(store, account)
          } finally {
            await store.close()
          }
        },
        name === undefined ? {} : { name },
      ),
    withServices: (work, { name } = {}) =>
      base.run(
        async (events) => {
          let held: ReturnType<typeof connected> | undefined
          let store: Promise<MessageStore> | undefined
          let released: Promise<void> | undefined
          const releaseConnection = () => (released ??= held?.close() ?? Promise.resolve())
          const deps: ServiceDeps = {
            messenger,
            profile,
            env: base.env,
            offline: base.settings.offline,
            reads: messenger.history ?? "server",
            // Turning recording off by name (--no-record, or record: false) keeps no search history either.
            history: base.settings.keepFailedRuns,
            searchCatchUp: base.settings.searchCatchUp,
            pictures: base.settings.pictureSearch,
            guard,
            connection: async () => {
              if (base.settings.offline) throw new CliError("validation_error", OFFLINE)
              if (released) throw new CliError("validation_error", "the read connection has already been released")
              if (!held) {
                const connection = await connectFor(command, messenger, base, { events })
                if (released) {
                  await connection.close()
                  throw new CliError("validation_error", "the read connection has already been released")
                }
                base.track(connection)
                held = connected(connection, messenger, base, events)
              }
              return held.adapter
            },
            account: async () => accountFor(),
            store: () => {
              store ??= openStore({ env: base.env, command: app.command }).then(async (opened) => {
                if (messenger.history === "store") await warnUnserved(messenger, profile, base, opened)
                return opened
              })
              return store
            },
          }
          try {
            return await work(servicesFor(deps), async (read) => {
              try {
                return await read(await deps.connection())
              } finally {
                await releaseConnection()
              }
            })
          } finally {
            try {
              await releaseConnection()
            } finally {
              if (store) await (await store.catch(() => undefined))?.close()
            }
          }
        },
        name === undefined ? {} : { name },
      ),
  }
}
