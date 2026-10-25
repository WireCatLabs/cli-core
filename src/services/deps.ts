import { CliError } from "@wirecat/cli-base"
import type { WarmEmbedders } from "../embeddings/embed.js"
import { isCliFailure } from "../errors/failures.js"
import type { AppIdentity } from "../ports/app.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { MessengerTraits } from "../ports/traits.js"
import { typedCommand } from "../runs/scope.js"
import type { SendGuard } from "../sends/guard.js"
import type { AccountStore } from "../store/account-store.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import type { Override } from "./index.js"

export interface ServiceMessenger extends MessengerTraits {
  /** Replaces shared use cases for this messenger; its commands and MCP tools both get the replacement. */
  services?: Override
}

/**
 * What a service works with. Each part is opened on first use, so a read from the store never
 * connects and a command that never touches the store never opens it. Whoever built the deps closes
 * what they opened.
 */
export interface ServiceDeps {
  messenger: ServiceMessenger
  offline: boolean
  /** `store`: the messenger's history is read from the local store (`MessengerTraits.history`); `server` when unset. */
  reads?: "server" | "store"
  account: () => Promise<AccountKey>
  /** Already saving what its reads answer, and recording each call as a run event. */
  connection: () => Promise<MessengerAdapter>
  /** A retained session serializes the whole fetch, including ingestion. */
  withConnection?: <T>(work: (adapter: MessengerAdapter) => Promise<T>) => Promise<T>
  /**
   * The whole store, every account in it. A service reads through `accountStore(deps)`; a read across
   * accounts on purpose names itself with `crossAccount(deps, reason)`.
   */
  store: () => Promise<MessageStore>
  guard: SendGuard
  /** For the profile's own files — a group's moderation rules. `default` and `process.env` when unset. */
  profile?: string
  env?: NodeJS.ProcessEnv
  /** A long-running process's open models, so a search does not load one each time. */
  embedders?: WarmEmbedders
  /** `false` keeps no search history: recording was turned off by name. Kept when unset. */
  history?: boolean
  searchCatchUp?: boolean
  /** This account has picture search on (`pictureSearch`): its images are embedded and searched by their pixels. */
  pictures?: boolean
  /** Which reranker orders `--discover`'s first hits (`searchReranker`), or `off`; the default when unset. */
  reranker?: string
  /** Opens the picture model; tests give a fake. */
  pictureEmbedder?: () => Promise<import("../images/picture/embedder.js").PictureEmbedder>
  agentText?: true
}

/** The store with the running account bound: the default for a service's reads and writes. */
export const accountStore = async (deps: Pick<ServiceDeps, "store" | "account">): Promise<AccountStore> =>
  (await deps.store()).forAccount(await deps.account())

/**
 * The whole store, for a read that spans accounts on purpose — `--source all`, `in:all`, `search all`.
 * `reason` says which, so every such read is found by searching for this name.
 */
export const crossAccount = (deps: Pick<ServiceDeps, "store">, _reason: string): Promise<MessageStore> => deps.store()

const NO_LOCAL_STORE = "this answer comes from the messenger, not from the local store"

/**
 * Busy: another process (`serve`) held the write lock past `busy_timeout`. Node's `node:sqlite` sets `errcode`,
 * Bun's `bun:sqlite` sets `errno`; the low byte is the primary code, so the extended BUSY codes match too.
 */
const SQLITE_BUSY = 5

const storeAbsent = (error: unknown): boolean => {
  if (isCliFailure(error)) return error.code === "validation_error" && error.message === NO_LOCAL_STORE
  const { errcode, errno } = (error ?? {}) as { errcode?: unknown; errno?: unknown }
  const code = errcode ?? errno
  return error instanceof Error && typeof code === "number" && (code & 0xff) === SQLITE_BUSY
}

/** `not_found`: nothing has recorded whose account this profile is; `authentication_error`: the connection has no self. */
const accountUnknown = (error: unknown): boolean =>
  isCliFailure(error) && (error.code === "not_found" || error.code === "authentication_error")

const unless = async <T>(work: () => Promise<T>, expected: (error: unknown) => boolean): Promise<T | undefined> => {
  try {
    return await work()
  } catch (error) {
    if (expected(error)) return undefined
    throw error
  }
}

/** A store write after the messenger already did the work: a store busy past its timeout leaves it unwritten. */
export const unlessBusy = <T>(work: () => Promise<T>): Promise<T | undefined> => unless(work, storeAbsent)

/** `accountStore`, or nothing when there is no store to read or the account is not known yet. */
export const accountStoreIfOpen = async (deps: ServiceDeps): Promise<AccountStore | undefined> => {
  const held = await storeIfOpen(deps)
  return held?.store.forAccount(held.account)
}

/**
 * Online, the store only adds to an answer the messenger already gave, so no store, a busy one, or one that
 * does not know whose account this is yet loses nothing. A store that is broken is an error.
 */
export const storeIfOpen = async (
  deps: ServiceDeps,
): Promise<{ store: MessageStore; account: AccountKey } | undefined> => {
  const store = await unless(() => deps.store(), storeAbsent)
  const account = store && (await unless(() => deps.account(), accountUnknown))
  return store && account ? { store, account } : undefined
}

/** Whether `chats`, `messages list|context` and `contacts` answer from the store instead of the messenger. */
export const fromStore = (deps: Pick<ServiceDeps, "offline" | "reads">): boolean =>
  deps.offline || deps.reads === "store"

/** What a store-mode read answers for a chat the store holds nothing of. */
export const nothingStored = (messenger: MessengerTraits): string =>
  `nothing stored for this chat yet — keep \`${typedCommand(messenger.app.command, "serve")}\` running`

/** Where a store-mode messenger's history comes from, for what it cannot do. */
export const PUSHED = "this messenger's history is read from the local store"

export const OFFLINE =
  "--offline answers only from what is kept locally: `chats list|show`, `messages list|show|context`, `contacts list|show` and `review`"

/** Over a connection that is already open — an MCP session holds one for minutes. */
export const onlineDeps = (
  messenger: ServiceMessenger,
  adapter: MessengerAdapter,
  guard: SendGuard,
  where: { profile?: string; env?: NodeJS.ProcessEnv; pictures?: boolean; reranker?: string } = {},
): ServiceDeps => ({
  messenger,
  ...where,
  offline: false,
  guard,
  connection: async () => adapter,
  account: async () => {
    const self = adapter.self()
    if (self === null) throw new CliError("authentication_error", "the connection does not know whose account it is")
    return { provider: messenger.provider, account: self }
  },
  store: async () => {
    throw new CliError("validation_error", NO_LOCAL_STORE)
  },
})

/** Over the local store alone, for `--offline` and the tools that never ask the messenger. */
export const storedDeps = (
  messenger: ServiceMessenger,
  store: MessageStore,
  account: AccountKey,
  guard: SendGuard,
): ServiceDeps => ({
  messenger,
  offline: true,
  reads: messenger.history ?? "server",
  guard,
  account: async () => account,
  store: async () => store,
  connection: async () => {
    throw new CliError("validation_error", OFFLINE)
  },
})

/**
 * The store-backed reads of a messenger whose history is kept there, for an MCP read: not
 * `--offline`, so `inbox` and `review` answer too. Nothing here connects.
 */
export const storeModeDeps = (
  messenger: ServiceMessenger,
  store: MessageStore,
  account: AccountKey,
  guard: SendGuard,
): ServiceDeps => ({ ...storedDeps(messenger, store, account, guard), offline: false, reads: "store" })

const NOT_A_MESSENGER = "this program keeps its sources in the store and has no messenger to connect to"

/**
 * For a program that is not a messenger but keeps its own sources in the store — `cli-memo`'s notes and
 * mail: the services that read and build from the store alone (conversations, embeddings, person
 * context). It has no connection and no settings to resolve, and its guard refuses every write.
 */
export const storeOnlyDeps = (
  store: MessageStore,
  account: AccountKey,
  { app, env }: { app: AppIdentity; env?: NodeJS.ProcessEnv },
): ServiceDeps => {
  const refuse = (): never => {
    throw new CliError("validation_error", NOT_A_MESSENGER)
  }
  const messenger: MessengerTraits = {
    app,
    provider: account.provider,
  }
  const guard: SendGuard = { check: refuse, record: () => {} }
  return { ...storedDeps(messenger, store, account, guard), ...(env === undefined ? {} : { env }) }
}
