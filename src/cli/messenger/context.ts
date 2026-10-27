import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { servingProfiles } from "../../background/lock.js"
import type {
  AdminRight,
  GroupSettingKey,
  Id,
  Message,
  Page,
  PollVote,
  PrivacyKey,
  Provider,
} from "../../domain/models.js"
import type { WarmEmbedders } from "../../embeddings/embed.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import type { EventSink, Warn, WarningEvent } from "../../runs/events.js"
import { FloodMemory, floodPathFor } from "../../sends/flood.js"
import { type Asker, ceilingRefusal, guardFor, type SendGuard } from "../../sends/guard.js"
import { DEFAULT_PACE, type PaceRate, Pacer, pacePathFor } from "../../sends/pace.js"
import { CEILING_KEY, levelFor, type PermissionKey, readKeysForCommand } from "../../sends/permissions.js"
import { RecipientList, recipientsPathFor } from "../../sends/recipients.js"
import { OFFLINE, type ServiceDeps, type ServiceMessenger, type Services, servicesFor } from "../../services/index.js"
import type { OpenRecognizer } from "../../speech/transcribe.js"
import { type AccountKey, type DeletionScope, type MessageStore, openStore } from "../../store/store.js"
import { type BaseContext, type BaseEnvironment, baseContext, environmentOf } from "../context.js"
import { type PermissionKeyOf, refuseUnknownPermissionKeys } from "../permission-keys.js"
import { asFirstWord } from "../profile.js"
import type { GlobalFlags, ResolveOptions, Settings } from "../settings.js"
import { rootOf } from "../steps.js"
import { recalledAccount, rememberAccount } from "./accounts.js"
import { terminalAsker } from "./ask.js"
import { flooded } from "./flooded.js"
import { refuseLacking } from "./lacks.js"
import { observed } from "./observed.js"
import { stored } from "./stored.js"

/**
 * What the local store holds of the connection's own account, read-only and opened on the first lookup — for an
 * adapter that addresses a message by more than its id (WhatsApp: by its sender and whether it is the owner's).
 * Answers nothing before the connection knows its account.
 */
export interface StoredMessages {
  message(chatId: Id, messageId: Id): Promise<Message | undefined>
  /** Stored messages in one provider thread, oldest first within the newest page. No remote fetch. */
  threadMessages?(chatId: Id, threadId: Id, window: { limit: number; before?: Id }): Promise<Page<Message>>
  /** The newest message from someone else in the chat, older than `before` when it is given. */
  newestIncoming(chatId: Id, before?: Id): Promise<Message | undefined>
  /** The newest message in the chat sent at `at` or earlier; without `at`, the oldest one held. */
  anchor(chatId: Id, at?: string): Promise<Message | undefined>
  /** Whether the account ever sent this person a message in a one-to-one chat. */
  wroteTo(personId: Id): Promise<boolean>
  /** Each voter's newest vote in the poll the message carries, newest first; a retracted vote has no answers. */
  pollVotes(chatId: Id, messageId: Id): Promise<PollVote[]>
}

/** `listen` opens a connection that receives updates — only `watch` asks; the rest stay quiet. */
export interface ConnectOptions {
  listen?: boolean
  /** Fetch what arrived while nothing listened — `serve` only; `watch` starts from now. */
  catchUp?: boolean
  /** The run's diagnostics, for a messenger that reports its own wire below the adapter's calls. */
  events?: EventSink
  /** The command's own store handle, never a second one; given on every connect the shared commands make. */
  stored?: StoredMessages
}

/** One store handle, opened on first use and closed once, shared by a connection's saves and its lookups. */
export interface LazyStore {
  open: () => Promise<MessageStore>
  close: () => Promise<void>
}

export const lazyStore = (env: NodeJS.ProcessEnv, command: string, version?: string): LazyStore => {
  let opened: Promise<MessageStore> | undefined
  return {
    open: () => {
      opened ??= openStore({ env, command, ...(version ? { version } : {}) })
      return opened
    },
    close: async () => {
      if (opened) await (await opened.catch(() => undefined))?.close()
    },
  }
}

export const storedMessages = (
  provider: Provider,
  store: () => Promise<MessageStore>,
  account: () => Id | null | undefined,
): StoredMessages => {
  const key = () => {
    const self = account()
    return self ? { provider, account: self } : undefined
  }
  return {
    message: async (chatId, messageId) => {
      const at = key()
      return at && (await store()).messages.message(at, messageId, { chatId })
    },
    threadMessages: async (chatId, threadId, window) => {
      const owner = key()
      return owner
        ? (await store()).messages.messages(owner, chatId, { ...window, threadId })
        : { items: [], hasMore: false }
    },
    newestIncoming: async (chatId, before) => {
      const at = key()
      if (!at) return undefined
      const page = await (await store()).messages.messages(at, chatId, {
        limit: 1,
        outgoing: false,
        ...(before === undefined ? {} : { before }),
      })
      return page.items.at(-1)
    },
    anchor: async (chatId, at) => {
      const owner = key()
      if (!owner) return undefined
      const window =
        at === undefined ? { at: new Date(0).toISOString(), before: 0, after: 1 } : { at, before: 1, after: 0 }
      return (await (await store()).messages.messagesWindow(owner, chatId, window))[0]
    },
    wroteTo: async (personId) => {
      const owner = key()
      if (!owner) return false
      const opened = await store()
      // A dialog named by its partner's id is the rule in WhatsApp and Telegram; MAX's are found by their members.
      const dialogs = new Set([
        personId,
        ...(await opened.chats.chatsWith(owner, personId))
          .filter((chat) => chat.kind === "dialog")
          .map((chat) => chat.id),
      ])
      for (const chatId of dialogs)
        if ((await opened.messages.messages(owner, chatId, { limit: 1, outgoing: true })).items.length > 0) return true
      return false
    },
    pollVotes: async (chatId, messageId) => {
      const owner = key()
      return owner ? (await store()).messages.pollVotes(owner, chatId, messageId) : []
    },
  }
}

export type ProfileState = "signed-in" | "signed-out" | "bot"

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
  /**
   * A profile's state, read from the messenger's own files without connecting: `signed-in` has a session, `signed-out`
   * has none yet, `bot` speaks for a bot. `<tool> mcp` with no profile offers the personal ones and marks those not
   * signed in; `account list` and the profile errors say so too. Unset: every profile counts as signed in.
   */
  profileState?: (profile: string, env: NodeJS.ProcessEnv) => ProfileState
  /** The help for a `<chat>` argument, in this messenger's words. */
  chatArgument: string
  /** The group settings this messenger has, as `chats update` offers them; every one when unset. */
  groupSettings?: readonly GroupSettingKey[]
  /** Whether `polls create` makes quizzes (`--quiz --correct --solution`); no when unset. */
  pollQuiz?: boolean
  /** How many seconds after sending a poll may close by itself — `polls create --close-time`; none when unset. */
  pollCloseSeconds?: readonly [min: number, max: number]
  /** Whether `polls voters` lists who voted for what; no when unset. */
  pollVoters?: boolean
  /** Whether a poll can be closed — `polls close`; yes when unset. WhatsApp's stay open. */
  pollClose?: boolean
  /**
   * Whether a new poll chooses if people may change their vote — `polls create --revote`; yes when unset. No: the
   * messenger decides alone (WhatsApp: a vote can always be changed).
   */
  pollRevote?: boolean
  /** Whether a new poll can hide who voted for what — `polls create --anonymous`; yes when unset. WhatsApp's never can. */
  pollAnonymous?: boolean
  /** Whether a send, a forward or a poll can go without a notification — `--silent`; yes when unset. */
  silentSends?: boolean
  /** Whether a send, a forward or a poll can be posted as another identity — `--send-as`; yes when unset. */
  sendAs?: boolean
  /** Whether the messenger sends a message later by itself — `messages send --at-time`; yes when unset. */
  scheduledSends?: boolean
  /**
   * Whether `serve` may answer messages by the reply rules, and `replies` manages them; yes when unset. No: nothing
   * sends unless a typed command asked (WhatsApp bans accounts that answer like a bot).
   */
  autoReplies?: boolean
  /**
   * Adapter methods this messenger never has. The commands that need one alone (`COMMAND_NEEDS`) refuse before
   * connecting, as the adapter would refuse after; one connection per device makes that connection a cost.
   */
  lacks?: readonly (keyof MessengerAdapter)[]
  /**
   * Adapter methods this messenger can never have, where `lacks` is what it does not have yet: their commands refuse
   * the same way and are also hidden from help, `commands` and MCP. WhatsApp: only the phone ends other sessions.
   */
  never?: readonly (keyof MessengerAdapter)[]
  /** Whether a message can be deleted for the owner alone; yes when unset. No: every delete is for everyone (WhatsApp). */
  deleteForMe?: boolean
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
  /** Whether `chats update --remove-photo` takes a group's photo away; no when unset. */
  groupPhotoRemoval?: boolean
  /**
   * The file extensions a profile photo takes — the owner's in `account update --photo`, a group's in `chats update
   * --photo` — checked before connecting; `.jpg`, `.jpeg`, `.png` and `.webp` when unset. WhatsApp takes JPEG alone.
   */
  profilePhotoTypes?: readonly string[]
  /** Whether `chats media` lists a chat's media from the server; no when unset. */
  chatMedia?: boolean
  /** Whether `account privacy show` and `set` read and change the account's privacy; no when unset. */
  privacy?: boolean
  /** The settings `account privacy set` offers; the first five of `PrivacySettings` when unset. */
  privacySettings?: readonly PrivacyKey[]
  /** Whether `chats mute` and `unmute` exist; no when unset. */
  chatMute?: boolean
  /** Whether `chats archive` and `unarchive` exist; no when unset. */
  chatArchive?: boolean
  /** Whether `chats pin` and `unpin` exist — a chat at the top of the list, not a message pin; no when unset. */
  chatPin?: boolean
  /** Whether `chats mark-unread` exists; no when unset. */
  chatMarkUnread?: boolean
  /** Whether `messages star` and `unstar` exist; no when unset. */
  messageStars?: boolean
  /** Whether `chats delete` and `chats clear` exist; no when unset. */
  chatDeletion?: boolean
  /** Whether `messages press`, `chats start` and `chats app` exist — a bot met on the personal account; no when unset. */
  personalBots?: boolean
  /** Whether `messages send --sticker` sends a sticker; no when unset. `stickers list` is a group a CLI adds itself. */
  stickers?: boolean
  /**
   * The largest .webp `messages send --sticker-file` sends as a sticker, in bytes; no `--sticker-file` when unset.
   * For a messenger whose sticker is an uploaded file, not one of a set (WhatsApp).
   */
  stickerFileBytes?: number
  /** Whether shared folders can be joined; yes when unset. */
  folderJoin?: boolean
  /** Whether another invite link can be made — `chats links create`; yes when unset. */
  inviteLinkCreate?: boolean
  /** Whether invite links can be listed; yes when unset. */
  inviteLinkList?: boolean
  /** Whether one invite link can be revoked; yes when unset. */
  inviteLinkRevoke?: boolean
  /** Whether one invite link can be changed — `chats links update`; no when unset. */
  inviteLinkUpdate?: boolean
  /** Whether every pending join request is answered at once — `chats requests confirm --all`; yes when unset. */
  joinRequestsAll?: boolean
  /** Whether `--all` can take only the requests made by one invite link — `--link`; yes when unset. */
  joinRequestsByLink?: boolean
  /** Whether a channel post can be commented on — `messages send --comment-to`; yes when unset. */
  channelComments?: boolean
  /** Whether comments can be read independently of sending; inherits channelComments when unset. */
  readsComments?: boolean
  /** Whether people added can be shown the messages from before they came — `members add --history`; yes when unset. */
  addsWithHistory?: boolean
  /** The admin rights this messenger has, as `admins add --can` offers them; every one when unset. */
  adminRights?: readonly AdminRight[]
  /**
   * Whether an admin gets some rights and not others — `admins add --can`; yes when unset. No: every admin has
   * every right in `adminRights`, so `admins add` takes no `--can` and gives them all.
   */
  pickAdminRights?: boolean
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
  guard?: (command: Command, settings: Settings, warn: Warn, ask?: Asker) => SendGuard
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
  /** Run for an agent over MCP, where a write at level `ask` goes ahead: nobody is at a terminal (NEED-773). */
  agent: boolean
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
/** A batch's history is saved behind its re-keys; an owner's `recipients` change holds the list for milliseconds. */
const REKEY_LOCK_WAIT_MS = 250

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

/** What a one-shot connection hands on and saves passively, and what its warnings call it. */
interface Passive {
  run: (signal: AbortSignal) => Promise<void> | undefined
  operation: string
  what: string
}

/**
 * Runs one passive listen until `stop`, which answers whether it ended in time. A listen that fails warns and
 * never fails the command; one that fails once the connection is `closing` is the close, not news. It still listens
 * while the connection closes, so what arrives then is saved too.
 */
const listened = (
  { run, operation, what }: Passive,
  events: EventSink,
  warn: Warn,
  waitMs: number,
): { closing: () => void; stop: () => Promise<boolean>; operation: string; what: string } => {
  const abort = new AbortController()
  let closing = false
  const ended = Promise.resolve()
    .then(() => run(abort.signal))
    .catch((error: unknown) => {
      if (closing) return
      const warning: WarningEvent = { event: "warning", code: "listen_failed", operation }
      events(warning)
      warn(
        `${what} arriving during this command are not saved: ${error instanceof Error ? error.message : String(error)}`,
        warning,
      )
    })
  return {
    operation,
    what,
    closing: () => {
      closing = true
    },
    stop: () => {
      abort.abort()
      return settled(new Set([ended]), waitMs)
    },
  }
}

/** The passive listens a connection of a `history: "store"` messenger runs: the ones its adapter has. */
const passivesOf = (adapter: MessengerAdapter): Passive[] => [
  ...(adapter.listen
    ? [
        {
          run: (signal: AbortSignal) => adapter.listen?.(() => {}, signal),
          operation: "messages.listen",
          what: "messages",
        },
      ]
    : []),
  ...(adapter.listenHistory
    ? [
        {
          run: (signal: AbortSignal) => adapter.listenHistory?.(() => {}, signal),
          operation: "history.listen",
          what: "history batches",
        },
      ]
    : []),
]

/** A list that cannot be read stays as it is, which refuses every send: the warning says why. */
const rekeyRecipients = async (
  app: Messenger["app"],
  profile: string,
  env: NodeJS.ProcessEnv,
  warn: Warn,
  from: Id,
  to: Id,
): Promise<void> => {
  try {
    await new RecipientList(recipientsPathFor(app, profile, env), app.command, REKEY_LOCK_WAIT_MS).rekey(from, to)
  } catch (error) {
    warn(`the recipient list still names ${from}: ${error instanceof Error ? error.message : String(error)}`, {
      event: "warning",
      code: "recipients_not_rekeyed",
      operation: "recipients.rekey",
    })
  }
}

/** The waits a test shortens through its environment; a run without them keeps the defaults. */
type ConnectionWaits = Pick<BaseEnvironment, "closeWaitMs" | "rekeyPacing">

const waitsOf = (command: Command): ConnectionWaits => {
  const { closeWaitMs, rekeyPacing } = environmentOf(command)
  return { ...(closeWaitMs === undefined ? {} : { closeWaitMs }), ...(rekeyPacing ? { rekeyPacing } : {}) }
}

/**
 * A connection as every shared reader sees it: its account remembered, each call a run event, what
 * the reads answer saved to the store. `close` closes the connection and the store it opened. One
 * function, so a command and an MCP tool call save and record exactly alike.
 *
 * A `history: "store"` messenger with `listen` or `listenHistory` saves what arrives for as long as a connection that
 * does not `watch` is open: what it queued while nothing was connected is delivered once and cannot be fetched again.
 * A connection opened with `listen: true` is left to its `watch` and `feed`, which save the same.
 */
export const connected = (
  connection: MessengerAdapter,
  {
    app,
    provider,
    name,
    deletedWithoutChat,
    pace,
    history,
    savedChatId,
    unreadCounts,
  }: Pick<
    Messenger,
    "app" | "provider" | "name" | "deletedWithoutChat" | "pace" | "history" | "savedChatId" | "unreadCounts"
  >,
  { settings, env, renderer }: Pick<BaseContext, "settings" | "env" | "renderer">,
  events: EventSink,
  store: LazyStore = lazyStore(env, app.command, app.version),
  {
    listen: watching = false,
    closeWaitMs = SAVES_WAIT_MS,
    rekeyPacing,
  }: Pick<ConnectOptions, "listen"> & ConnectionWaits = {},
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
  const pending = new Set<Promise<void>>()
  const announcing = new Set<Promise<void>>()
  const closing = new AbortController()
  const saving =
    self === null
      ? adapter
      : stored(adapter, {
          account: { provider, account: self },
          profile: { app: app.command, name: settings.profile },
          store: store.open,
          warn: renderer.warn,
          events,
          pending,
          announcing,
          closing: closing.signal,
          ...(deletedWithoutChat ? { deletedWithoutChat } : {}),
          ...(rekeyPacing ? { rekeyPacing } : {}),
          rekeyed: (from, to) => rekeyRecipients(app, settings.profile, env, renderer.warn, from, to),
          recipientIds: () =>
            (new RecipientList(recipientsPathFor(app, settings.profile, env), app.command).read() ?? []).flatMap(
              (recipient) => [recipient.id, ...(recipient.partnerId ? [recipient.partnerId] : [])],
            ),
          ...(history === "store" ? { namesFromStore: savedChatId ? { savedChatId } : {} } : {}),
          ...(unreadCounts === "store" ? { countsUnread: true } : {}),
        })
  const passives =
    history === "store" && self !== null && !watching
      ? passivesOf(saving).map((passive) => listened(passive, events, renderer.warn, closeWaitMs))
      : []
  return {
    adapter: saving,
    close: async () => {
      for (const passive of passives) passive.closing()
      try {
        await connection.close()
      } finally {
        try {
          const ended = await Promise.all(passives.map((passive) => passive.stop()))
          const warn: Warn = renderer.warn
          const warned = (warning: WarningEvent, text: string) => {
            events(warning)
            warn(text, warning)
          }
          passives.forEach(({ operation, what }, at) => {
            if (ended[at]) return
            warned(
              { event: "warning", code: "store_not_written", operation },
              `not saved to the local store: the messenger was still handing on ${what} at exit`,
            )
          })
          await settled(new Set([...pending, ...announcing]), closeWaitMs)
          closing.abort()
          if (pending.size > 0)
            warned(
              { event: "warning", code: "store_not_written", operation: "close" },
              "not saved to the local store: the last messages were still being written at exit",
            )
          if (announcing.size > 0)
            warned(
              { event: "warning", code: "stored_chats_failed", operation: "close" },
              "the messenger's stored-chats hook did not finish and was abandoned at exit; nothing is lost",
            )
        } finally {
          await store.close()
        }
      }
    },
  }
}

/** `connectFor` and then `connected`, over one store handle: what the reads save and what the adapter looks up. */
export const connectedFor = async (
  command: Command,
  messenger: Pick<
    Messenger,
    "connect" | "app" | "provider" | "name" | "deletedWithoutChat" | "pace" | "history" | "savedChatId" | "unreadCounts"
  >,
  base: BaseContext,
  options: ConnectOptions & { events: EventSink },
): Promise<{ connection: MessengerAdapter; adapter: MessengerAdapter; close: () => Promise<void> }> => {
  const store = lazyStore(base.env, messenger.app.command, messenger.app.version)
  let connection: MessengerAdapter | undefined
  try {
    connection = await connectFor(command, messenger, base, {
      ...options,
      stored: storedMessages(messenger.provider, store.open, () => connection?.self()),
    })
  } catch (error) {
    await store.close()
    throw error
  }
  return {
    connection,
    ...connected(connection, messenger, base, options.events, store, {
      ...waitsOf(command),
      ...(options.listen ? { listen: true } : {}),
    }),
  }
}

/** `default (not signed in)`: a profile as an error lists it among the choices. */
export const markedProfile = (messenger: Messenger, profile: string, env: NodeJS.ProcessEnv): string =>
  messenger.profileState?.(profile, env) === "signed-out" ? `${profile} (not signed in)` : profile

const unrecorded = (
  command: Command,
  messenger: Messenger,
  profile: string,
  { offline, profilesHere }: Pick<Settings, "offline" | "profilesHere">,
  env: NodeJS.ProcessEnv,
): CliError => {
  if (!profilesHere.includes(profile)) {
    return new CliError(
      "not_found",
      `no profile named "${profile}" — profiles here: ${profilesHere.length > 0 ? profilesHere.map((one) => markedProfile(messenger, one, env)).join(", ") : "none"}`,
      { profiles: profilesHere },
    )
  }
  const words = `${messenger.app.command} ${asFirstWord(profile)}`
  const setup = rootOf(command).commands.some((one) => one.name() === "setup") ? `\`${words}setup\`` : undefined
  if (messenger.history === "store")
    return new CliError(
      "not_found",
      `nothing recorded for profile "${profile}" yet — ${setup ? `link it with ${setup}, then ` : ""}run ` +
        `\`${words}serve\` or \`${words}watch\` once to fill the local store`,
    )
  const ways = [
    ...(setup ? [`log in with ${setup}`] : []),
    ...(offline ? ["run the command once without --offline"] : []),
  ]
  return new CliError(
    "not_found",
    `nothing recorded for profile "${profile}" yet — ${ways.length > 0 ? ways.join(", or ") : "log in to it first"}`,
  )
}

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
    `no \`${messenger.app.command} ${profile} serve\` keeps profile "${profile}" up to date — ` +
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
  if (level === "allow" || (level === "ask" && context.agent)) return
  if (key === CEILING_KEY) throw ceilingRefusal(permission, command)
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
  refuseLacking(messenger, pathOf(command))
  refuseUnknownPermissionKeys(command, base.settings, app.command, messenger.permissionKey)
  // Read when warning, not now: serve swaps the renderer's methods for log records after this.
  const warn: Warn = (text, warning) => (base.renderer.warn as Warn)(text, warning)
  const accountFor = (): AccountKey => {
    const account = messenger.accountOf?.(command) ?? recalledAccount(app, provider, profile, base.env)
    if (!account) throw unrecorded(command, messenger, profile, base.settings, base.env)
    return account
  }
  const guard =
    messenger.guard?.(command, base.settings, warn) ??
    guardFor(app, base.settings, warn, base.env, terminalAsker(command))
  // The MCP server's open models, so a command it runs does not load a second copy.
  const { embedders } = environmentOf<BaseEnvironment & { embedders?: WarmEmbedders }>(command)

  return {
    ...base,
    agent: environmentOf(command).agent !== undefined,
    profile,
    stdin: environmentOf(command).stdin ?? process.stdin,
    ...(environmentOf(command).recognizer ? { recognizer: environmentOf(command).recognizer } : {}),
    guard,
    withMessenger: (work, options = {}) =>
      base.run(
        async (events) => {
          if (base.settings.offline) throw new CliError("validation_error", OFFLINE)
          const { connection, adapter, close } = await connectedFor(command, messenger, base, { ...options, events })
          base.track(connection)
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
          const store = await openStore({ env: base.env, command: app.command, version: app.version })
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
          let warned: Promise<MessageStore> | undefined
          let released: Promise<void> | undefined
          const releaseConnection = () => (released ??= held?.close() ?? Promise.resolve())
          const openOnce = () => (store ??= openStore({ env: base.env, command: app.command, version: app.version }))
          const deps: ServiceDeps = {
            messenger,
            profile,
            env: base.env,
            offline: base.settings.offline,
            reads: messenger.history ?? "server",
            // Turning recording off by name (--no-record, or record: false) keeps no search history either.
            history: base.settings.record,
            searchCatchUp: base.settings.searchCatchUp,
            pictures: base.settings.pictureSearch,
            reranker: base.settings.searchReranker,
            guard,
            ...(embedders ? { embedders } : {}),
            connection: async () => {
              if (base.settings.offline) throw new CliError("validation_error", OFFLINE)
              if (released) throw new CliError("validation_error", "the read connection has already been released")
              if (!held) {
                let connection: MessengerAdapter | undefined
                connection = await connectFor(command, messenger, base, {
                  events,
                  stored: storedMessages(messenger.provider, openOnce, () => connection?.self()),
                })
                if (released) {
                  await connection.close()
                  throw new CliError("validation_error", "the read connection has already been released")
                }
                base.track(connection)
                held = connected(connection, messenger, base, events, undefined, waitsOf(command))
              }
              return held.adapter
            },
            account: async () => accountFor(),
            // The connect's stored lookup opens the store too; only a service reading its answer there warns.
            store: () => {
              warned ??= openOnce().then(async (opened) => {
                if (messenger.history === "store") await warnUnserved(messenger, profile, base, opened)
                return opened
              })
              return warned
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
