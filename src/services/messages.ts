import { CliError } from "@wirecat/cli-base"
import type { DownloadedFile, StickerFile, Upload } from "../domain/attachments.js"
import { type FormattedText, validateFormattedText, visibleFormattedText } from "../domain/formatting.js"
import { formatLocator } from "../domain/locator.js"
import { type MessageLink, messageLinkTarget, validatePermalink } from "../domain/message-link.js"
import type { Deletion, Discussion, Id, Message, Page, Provider, WindowedMessage } from "../domain/models.js"
import { pinDurationsText } from "../domain/pin-duration.js"
import { threadIdOf } from "../domain/thread.js"
import { type After, capability, type Download, type MessengerAdapter, type Sent } from "../ports/messenger.js"
import type { MediaOption, MessengerTraits } from "../ports/traits.js"
import type { SkippedSource } from "../search/account-list.js"
import { codeOf, guardedWrite, type Operated, sentIds } from "../sends/guarded.js"
import type { PermissionKey } from "../sends/permissions.js"
import { sendAsCheck } from "../sends/send-as.js"
import { newOperationId, newSendId } from "../sends/send-id.js"
import { uploadSize } from "../sends/upload.js"
import type {
  AccountKey,
  ChatCompleteness,
  MatchPlace,
  MessageStore,
  SearchCommand,
  StoredHit,
} from "../store/store.js"
import { crossAccount, fromStore, PUSHED, type ServiceDeps } from "./deps.js"
import { readChatId, storedChatId } from "./message-resolution.js"
import { accountOf, keyOf, searchStore, statsStore, topUp } from "./messages-archive-search.js"
import type { MeaningSkipped, RerankSkipped } from "./messages-discovery.js"
import { meaningLane } from "./messages-meaning.js"
import { rerankLane } from "./messages-rerank.js"
import type { MessageStats, QueryMetadata, SearchCoverage, StatsGrouping } from "./messages-search.js"
import type { PictureHit } from "./pictures.js"
import { type SearchAllFound, type SearchAllRequest, searchAll } from "./search-all.js"
import {
  type SearchAllIncludingMeetingsFound,
  type SearchAllWithMeetingsRequest,
  searchAllWithMeetings,
} from "./search-all-meetings.js"
import type { SearchKind } from "./search-kind.js"
import { type SearchParams, searchRecordOf } from "./search-record.js"
import { refreshSearch, type SearchRefreshed, type SyncOptions, withRefresh } from "./search-refresh.js"
import {
  type Backend,
  type HitSource,
  type ServerOptions,
  type ServerSearched,
  type ServerStep,
  searchServer,
  sourceKey,
} from "./server-search.js"
import { readThreadContext, type ThreadContext, type ThreadOptions, threadBounds } from "./thread-context.js"

export interface ListWindow {
  limit: number
  before?: string
  /** Read back from this moment, epoch milliseconds. */
  beforeTime?: number
  /** Read forward from this message or moment, parsed by the caller in its own words (`afterOf`). */
  after?: After
  /** Only the messages the owner starred (true) or did not (false); the store answers it, never the messenger. */
  starred?: boolean
  /** Only this forum topic. */
  threadId?: string
}

export interface AroundWindow {
  before: number
  after: number
}

export interface SearchQuery {
  thread?: ThreadOptions
  syncFirst?: SyncOptions
  /** Where to search: the local archive, the messenger's server, or both (the default). */
  backend?: Backend
  server?: ServerOptions
  /** Only these messages, each named with its account — `--backend server` searches what the server returned. */
  only?: (AccountKey & { chatId: Id; id: Id })[]
  text?: string
  discover?: boolean
  timezone?: string
  ast?: unknown
  signal?: AbortSignal
  chat?: string
  /** A messenger the store holds, or `all` — the same as `in:` in the query. The account it runs as when unset. */
  source?: string
  /** These accounts instead of the one it runs as, already checked by the caller; not with `source` or `in:`. */
  accounts?: AccountKey[]
  /** `messages` leaves mail out and refuses `in:email`; `mail` reads the mailboxes only. Every kind when unset. */
  kind?: SearchKind
  /** With `kind: "mail"`, only this mail account, by its address; every mail account when unset. */
  mailAccount?: string
  /** Any of these senders, already resolved by the caller; not with `from:`. */
  senders?: { provider: Provider; id: Id }[]
  limit: number
  /** Skip this many hits: the `nextOffset` of the page before. */
  offset?: number
  /** Newest first instead of best first. */
  newest?: boolean
  /** Bare words and quotes match their exact form only: the default field becomes `exact`. */
  exact?: boolean
  /** Messages before and after each hit, from the store. */
  context?: number
  /** The saved search this run came from (`--saved`), by id: its row counts the run too. */
  saved?: string
}

export type FoundMessage = StoredHit & {
  discovery?: {
    coverage: number
    matchedTerms: string[]
    missingTerms: string[]
    parent?: string
    /** Only when meaning was searched too: which of the two lists found it. */
    foundBy?: ("words" | "meaning")[]
    /** Only when the reranker read it: the cross-encoder's own score, higher is better. */
    rerankerScore?: number
  }
  match?: "words" | "beginnings" | "corrected"
  /** The garbled spellings a `corrected` hit's transcript holds, per query word. */
  corrections?: { from: string; to: string[] }[]
  /** Where the words were: the text, a voice note's transcript, a file's name or a file's text. */
  matchedIn?: MatchPlace
  score?: number | null
  exact?: boolean
  source?: HitSource
  context?: WindowedMessage[]
  /** A discovery hit's later messages that share a rare word with it, latest first; one may change or cancel it. */
  followUps?: FoundMessage[]
  thread?: ThreadContext
}

export interface SearchFound extends Page<FoundMessage> {
  /** Where the next page starts, as `offset`; absent on the last page. */
  nextOffset?: number
  refreshed?: SearchRefreshed
  server?: ServerSearched
  query?: QueryMetadata
  coverage?: SearchCoverage
  /** `--source` entries naming no account this search reads, and why. */
  skipped?: SkippedSource[]
  /** `search mail`: the mailboxes read. `search messages` answers `coverage.accounts`. */
  accounts?: { resource: "mail"; provider: string; account: string }[]
  corrections: { from: string; to: string[] }[]
  /** Per chat of the page: how much of its history the store holds. */
  completeness: (ChatCompleteness & AccountKey)[]
  /** `--discover` searched by words alone: why meaning was not searched, and the step that would enable it. */
  meaningSkipped?: MeaningSkipped
  /** `--discover` kept its own order: why the reranker did not read the hits, and the step that would let it. */
  rerankSkipped?: RerankSkipped
  /** `false` while the word index is being built. */
  wordsReady: boolean
  /** The same for the stems, in strict search: `false` until a stemmed search may run. */
  stemsReady?: boolean
  /**
   * The images nearest to what the words describe, found by their pixels and ranked on their own: not fused into
   * `items`. Only when the profile turned picture search on and the model is downloaded; queries are English.
   */
  pictures?: PictureHit[]
  /** Why a profile with picture search on has no `pictures` list: the model is not downloaded. */
  picturesSkipped?: string
  /** The picture model to download, when its absence is why `picturesSkipped` is set. */
  picturesModel?: string
}

export interface SendRequest {
  chat: string
  /** As typed: with `markdown`, the marks are taken out before it is sent or measured. */
  text: string
  sendId?: string
  replyTo?: string
  threadId?: string
  silent?: boolean
  noPreview?: boolean
  markdown?: boolean
  /** The text is HTML; not with `markdown`. */
  html?: boolean
  /** ISO time to send it at; refused together with `sendId`. */
  at?: string
  attachments?: Upload[]
  /** The level it is checked against, where it is not `messages.send`: a rule's reply is `replies.send`. */
  key?: PermissionKey
  /** Who sent it, in the send journal: `rule:<id>`. */
  origin?: string
  spoiler?: boolean
  captionAbove?: boolean
  /** A sticker by id, sent alone. */
  sticker?: Id
  /** A .webp sent as a sticker, alone. */
  stickerFile?: StickerFile
  /** One of the ids `chats.sendAs` lists for this chat. */
  sendAs?: Id
  /** A post of `chat`, a channel: the message goes to the post's discussion as a reply to it. */
  commentTo?: Id
}

export type DraftRequest = Pick<
  SendRequest,
  "chat" | "text" | "replyTo" | "threadId" | "markdown" | "html" | "noPreview"
>

/** One message in a chat, as typed. */
export interface MessageTarget {
  chat: string
  message: string
}

export interface Pinned {
  chatId: Id
  messageId: Id
  pinned: boolean
}

export interface Starred {
  chatId: Id
  messageId: Id
  starred: boolean
}

export interface Reacted {
  chatId: Id
  messageId: Id
  /** `null` once it is taken off. */
  reaction: string | null
}

/** max-cli's: many at once is what a ban for automation looks like. */
export const DELETE_AT_ONCE = 10

/** Every write goes through the guard: asked before it goes, told after, on every outcome. */
export interface MessagesService {
  /** The account these messages are read as, which names each one's locator. */
  reader(): Promise<AccountKey>
  list(chat: string, window: ListWindow): Promise<Page<Message>>
  around(chat: string, message: string | undefined, window: AroundWindow): Promise<WindowedMessage[]>
  thread(chat: string, message?: Id, options?: ThreadOptions): Promise<ThreadContext>
  link(chat: string, message?: string): Promise<MessageLink>
  /** A channel post's comments, from the messenger; `discussion` says where they live. */
  comments(
    chat: string,
    post: string,
    window: { limit: number; before?: string },
  ): Promise<Page<Message> & { discussion: Discussion }>
  /** The files of one message. Always from the messenger, whatever its history is read from. */
  download(chat: string, message: Id): Promise<Download>
  /**
   * Records in the local store where the files went, so their text can be read later. Only a
   * message the store holds; answers how many attachments it recorded.
   */
  keepDownloaded(chat: string, message: Id, files: readonly DownloadedFile[]): Promise<number>
  /** From the local store only; never asks the messenger. */
  search(query: SearchQuery): Promise<SearchFound>
  /** Messages, mail and notes at once; messages with the same server step `search` takes. */
  searchAll(request: SearchAllRequest): Promise<SearchAllFound>
  /** `searchAll` plus one meeting account's transcripts, chat and summaries. */
  searchAllWithMeetings(request: SearchAllWithMeetingsRequest): Promise<SearchAllIncludingMeetingsFound>
  /** Counts of what a strict query matches, by chat, sender, day or hour; from the local store only. */
  stats(query: SearchQuery & { by: StatsGrouping }): Promise<MessageStats>
  saveDraft?(request: DraftRequest): Promise<Operated<{ chatId: Id; saved: true }>>
  /** A reply is a send with `replyTo`. */
  send(request: SendRequest): Promise<Operated<Sent>>
  /** With `markdown` or `html`, the marks are taken out as a send takes them. */
  edit(
    target: MessageTarget & { text: string; markdown?: boolean; html?: boolean },
  ): Promise<Operated<{ message: Message }>>
  /** Each message counts toward the hourly limit. */
  delete(request: { chat: string; messages: string[]; forEveryone: boolean }): Promise<Operated<Deletion>>
  /** Guarded against the chat it goes to: that is where somebody new reads it. */
  forward(
    target: MessageTarget & { to: string; silent: boolean; sendId?: string; sendAs?: Id; threadId?: Id },
  ): Promise<Operated<{ sendId: string; message: Message }>>
  /**
   * Counts toward the hourly limit only when it notifies, which every pin does where the messenger has no quiet
   * one. `duration`, in seconds, is one of the messenger's `pinDurations`; its `pinDefaultDuration` when absent.
   */
  pin(target: MessageTarget & { notify: boolean; duration?: number }): Promise<Operated<Pinned>>
  unpin(target: MessageTarget): Promise<Operated<Pinned>>
  /** Only the owner sees a star, so it never counts toward the hourly limit. */
  star(target: MessageTarget & { starred: boolean }): Promise<Operated<Starred>>
  /** `null` takes the reaction off. A reaction never counts toward the hourly limit. */
  react(target: MessageTarget & { emoji: string | null }): Promise<Operated<Reacted>>
}

export const messagesService = (deps: ServiceDeps): MessagesService => {
  const { guard } = deps
  const inStore = async <T>(read: (store: MessageStore, account: AccountKey) => Promise<T>): Promise<T> =>
    read(await deps.store(), await deps.account())

  const serverThenStore = async (store: MessageStore, account: AccountKey, query: SearchQuery) => {
    const server = await searchServer(deps, query)
    const only =
      query.backend === "server" && server
        ? [...server.sources.keys()].map((key) => {
            const [chatId, id] = JSON.parse(key) as [Id, Id]
            return { ...account, chatId, id }
          })
        : undefined
    const found = await searchStore(
      store,
      account,
      only ? { ...query, only } : query,
      deps.messenger,
      query.discover && query.kind !== "mail" ? meaningLane(deps) : undefined,
      query.discover && query.kind !== "mail" ? rerankLane(deps) : undefined,
    )
    return { found, server }
  }

  const unifiedMessages =
    (store: MessageStore, account: AccountKey) =>
    async (query: SearchQuery): Promise<SearchFound> => {
      await topUp(store)
      const { found, server } = await serverThenStore(store, account, query)
      return withServer(found, account, server)
    }

  /**
   * Only a run that answered is kept: a refused query is the caller's typo, not a search. The answer is
   * already in hand, so a history write that fails — the store busy under `serve` — never fails the search.
   */
  const remember = async (store: MessageStore, command: SearchCommand, query: SearchQuery & { by?: StatsGrouping }) => {
    if (deps.history === false) return
    await store.searches
      .recordSearch(searchRecordOf(command, paramsOf(command, query)), {
        ...(query.saved === undefined ? {} : { saved: query.saved }),
      })
      .catch(() => undefined)
  }

  const pinning = async (
    { chat, message }: MessageTarget,
    pinned: boolean,
    asked: boolean,
    requested?: number,
  ): Promise<Operated<Pinned>> => {
    const allowed = deps.messenger.pinDurations
    if (requested !== undefined && !allowed?.includes(requested))
      throw new CliError(
        "validation_error",
        allowed?.length ? `a pin lasts ${pinDurationsText(allowed)} here` : "pins here never expire",
      )
    const duration = pinned ? (requested ?? deps.messenger.pinDefaultDuration) : undefined
    const notify = pinned && (asked || deps.messenger.quietPins === false)
    const connection = await deps.connection()
    const act = pinned
      ? capability(connection, "pin", "pin a message")
      : capability(connection, "unpin", "unpin a message")
    const { id: chatId } = await connection.resolve(chat)
    const operationId = newOperationId()
    await guardedWrite(
      guard,
      { operationId, chatId, kind: "pin", key: pinned ? "messages.pin" : "messages.unpin", messageId: message, notify },
      () => act(chatId, message, { notify, ...(duration === undefined ? {} : { duration }) }),
    )
    return { operationId, chatId, messageId: message, pinned }
  }

  const topicPage = async (
    chat: string,
    threadId: string,
    { limit, before, beforeTime, after }: ListWindow,
  ): Promise<Page<Message>> => {
    if (beforeTime !== undefined || after !== undefined)
      throw new CliError("validation_error", "a topic is read back from its newest message, or from --before-id")
    if (threadId === "1")
      throw new CliError(
        "validation_error",
        "the General topic's messages carry no topic id — read the whole chat without --topic",
      )
    const window = { limit, ...(before === undefined ? {} : { before }) }
    if (fromStore(deps)) {
      return inStore(async (store, account) =>
        store.messages.messages(account, await readChatId(deps, chat, store, account), { ...window, threadId }),
      )
    }
    return capability(await deps.connection(), "topicHistory", "read one forum topic")(chat, threadId, window)
  }

  const listPage = async (
    chat: string,
    { limit, before, beforeTime, after, threadId: typedThread, starred }: ListWindow,
  ): Promise<Page<Message>> => {
    if (starred !== undefined) {
      if (!fromStore(deps))
        throw new CliError("validation_error", "starred: reads the local store; not while reading from the messenger")
      if (typedThread !== undefined || beforeTime !== undefined || after !== undefined)
        throw new CliError("validation_error", "starred: pages back through the whole chat; give only id< with it")
      return inStore(async (store, account) =>
        store.messages.messages(account, await readChatId(deps, chat, store, account), {
          limit,
          ...(before === undefined ? {} : { before }),
          starred,
        }),
      )
    }
    const threadId = threadIdOf(typedThread)
    if (threadId !== undefined) return topicPage(chat, threadId, { limit, before, beforeTime, after })
    if (beforeTime !== undefined) {
      if (deps.offline)
        throw new CliError("validation_error", "reading back from a time asks the messenger; not with --offline")
      if (fromStore(deps)) throw new CliError("validation_error", `${PUSHED}, which pages back from a message only`)
      const connection = await deps.connection()
      return capability(connection, "historyBefore", "read back from a time")(chat, { limit, time: beforeTime })
    }
    if (after !== undefined) {
      if (deps.offline)
        throw new CliError("validation_error", "reading forward asks the messenger; the store pages only backwards")
      if (fromStore(deps)) throw new CliError("validation_error", `${PUSHED}, which pages only backwards`)
      const connection = await deps.connection()
      return capability(connection, "historyAfter", "read forward from a message")(chat, { limit, after })
    }
    const window = { limit, ...(before === undefined ? {} : { before }) }
    if (fromStore(deps)) {
      return inStore(async (store, account) =>
        store.messages.messages(account, await readChatId(deps, chat, store, account), window),
      )
    }
    return capability(await deps.connection(), "history", "read a chat's history")(chat, window)
  }

  return {
    // A provider caps its pages (Telegram at 100), so a larger --limit reads on from the last page's edge.
    // Only by id: where `before` is a send time (MAX), messages sharing the edge moment would be skipped.
    reader: () => deps.account(),

    list: async (chat, window) => {
      const forward = window.after !== undefined
      let page = await listPage(chat, window)
      let items = page.items
      const byId = (deps.messenger.fetching?.orderBy ?? "id") === "id"
      while (byId && page.hasMore && items.length < window.limit) {
        const edge = forward ? items.at(-1) : items[0]
        if (!edge) break
        const { beforeTime: _first, ...rest } = window
        const next = forward
          ? { ...rest, limit: window.limit - items.length, after: { id: edge.id } }
          : { ...rest, limit: window.limit - items.length, before: edge.id }
        page = await listPage(chat, next)
        const seen = new Set(items.map((one) => one.id))
        const fresh = page.items.filter((one) => !seen.has(one.id))
        if (fresh.length === 0) break
        items = forward ? [...items, ...fresh] : [...fresh, ...items]
      }
      return { items, hasMore: page.hasMore }
    },

    around: async (reference, message, window) => {
      const target = messageLinkTarget(reference, message, deps.messenger.provider)
      if (target.account !== undefined) {
        const account = await deps.account()
        if (account.provider !== deps.messenger.provider || target.account !== account.account)
          throw new CliError("validation_error", "that locator belongs to another account; select its profile first")
      }
      if (fromStore(deps)) {
        return inStore(async (store, account) =>
          store.messages.around(account, await readChatId(deps, target.chat, store, account), target.message, window),
        )
      }
      return capability(await deps.connection(), "around", "read the messages around one")(
        target.chat,
        target.message,
        window,
      )
    },

    thread: (reference, message, options) =>
      inStore(async (store, account) => {
        const target = messageLinkTarget(reference, message, deps.messenger.provider)
        if (
          account.provider !== deps.messenger.provider ||
          (target.account !== undefined && target.account !== account.account)
        )
          throw new CliError("validation_error", "that locator belongs to another account; select its profile first")
        return readThreadContext(
          store,
          account,
          await storedChatId(deps.messenger, target.chat, store, account, { includeLeft: true }),
          target.message,
          options,
        )
      }),

    comments: async (chat, typedPost, window) => {
      const post = typedPost.trim()
      if (post === "") throw new CliError("validation_error", "which post? give its message id in the channel")
      if (deps.offline)
        throw new CliError("validation_error", "comments are read from the messenger; not with --offline")
      const connection = await deps.connection()
      const discussionOf = capability(connection, "discussionOf", "read comments on a channel post")
      const comments = capability(connection, "comments", "read comments on a channel post")
      const { id: channelId } = await connection.resolve(chat)
      const discussion = await discussionOf(channelId, post)
      return { discussion, ...(await comments(channelId, post, window)) }
    },

    link: async (reference, message) => {
      const target = messageLinkTarget(reference, message, deps.messenger.provider)
      const account = await deps.account()
      if (
        account.provider !== deps.messenger.provider ||
        (target.account !== undefined && target.account !== account.account)
      )
        throw new CliError("validation_error", "that locator belongs to another account; select its profile first")
      if (fromStore(deps)) {
        const store = await deps.store()
        const chat = await readChatId(deps, target.chat, store, account)
        const found = await store.messages.around(account, chat, target.message, { before: 0, after: 0 })
        if (!found.some((item) => item.id === target.message && item.chatId === chat))
          throw new CliError("not_found", "no such message in this account's stored chat")
        return {
          locator: formatLocator({ ...account, chat, message: target.message }),
          url: null,
          access: "unavailable",
          reason: deps.offline ? "offline" : "unsupported_provider",
        }
      }
      const connection = await deps.connection()
      if (connection.self() !== account.account)
        throw new CliError(
          "authentication_error",
          "the connected account differs from the recorded profile; refresh the session before linking",
        )
      const { id: chat } = await connection.resolve(target.chat)
      const locator = formatLocator({ ...account, chat, message: target.message })
      if (connection.permalink)
        return { locator, ...validatePermalink(await connection.permalink(chat, target.message)) }
      const found = await capability(connection, "around", "read a message")(chat, target.message, {
        before: 0,
        after: 0,
      })
      if (!found.some((item) => item.id === target.message && item.chatId === chat))
        throw new CliError("not_found", "no such message in this chat")
      return { locator, url: null, access: "unavailable", reason: "unsupported_provider" }
    },

    download: async (chat, message) => {
      const connection = await deps.connection()
      const download = capability(connection, "download", "download attachments")
      return download((await connection.resolve(chat)).id, message)
    },

    keepDownloaded: (chat, message, files) =>
      inStore(async (store, account) => {
        const chatId =
          (await storedChatId(deps.messenger, chat, store, account).catch(() => undefined)) ??
          (await (await deps.connection()).resolve(chat)).id
        return store.attachments.keepDownloads(account, chatId, message, files)
      }),

    search: (request) => {
      if (request.discover && request.backend === "server")
        throw new CliError("validation_error", "discovery searches the local archive; use backend archive")
      const query: SearchQuery = {
        ...request,
        // Mail is only ever in the local store, and a saved search replays as `search messages`.
        ...(request.kind === "mail" || request.discover ? { backend: "archive" as const } : {}),
      }
      const opened =
        query.kind === "mail"
          ? crossAccount(deps, "search mail reads every mail account unless --account names one")
          : deps.store()
      return opened.then(async (store) => {
        const account = await deps.account()
        if (query.thread) threadBounds(query.thread)
        const refreshed = await refreshSearch(deps, query)
        // The server step reads the indexes to translate the query, so they are topped up first.
        if (query.backend !== undefined && query.backend !== "archive") await topUp(store)
        const { found, server } = await serverThenStore(store, account, query)
        if (query.kind !== "mail") await remember(store, "search", query)
        return withServer(withRefresh(found, refreshed), account, server)
      })
    },

    searchAll: (request) =>
      inStore((store, account) =>
        searchAll(store, account, request, deps.messenger, unifiedMessages(store, account), meaningLane(deps)),
      ),

    searchAllWithMeetings: (request) =>
      inStore((store, account) =>
        searchAllWithMeetings(
          store,
          account,
          request,
          deps.messenger,
          unifiedMessages(store, account),
          meaningLane(deps),
        ),
      ),

    stats: (query) =>
      inStore(async (store, account) => {
        const refreshed = await refreshSearch(deps, query)
        const stats = await statsStore(store, account, query, deps.messenger)
        await remember(store, "stats", query)
        return withRefresh(stats, refreshed)
      }),

    saveDraft: async ({ chat, text: typed, replyTo, threadId: typedThread, markdown, html, noPreview }) => {
      if (typed.trim() === "")
        throw new CliError("validation_error", "a draft needs nonempty text; clearing a draft is not supported")
      const connection = await deps.connection()
      const save = capability(connection, "saveDraft", "save a draft")
      const prepared = await formatted(connection, typed, { markdown, html })
      const { text, spans } = deps.agentText ? visibleFormattedText(prepared) : prepared
      if (text.trim() === "") throw new CliError("validation_error", "a draft needs nonempty text after formatting")
      const threadId = threadIdOf(typedThread)
      const validate =
        threadId === undefined ? undefined : capability(connection, "validateThread", "save a draft in a forum topic")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(
        guard,
        { operationId, chatId, kind: "edit", key: "drafts", length: text.length },
        () =>
          save(chatId, text, {
            ...(replyTo === undefined ? {} : { replyTo }),
            ...(threadId === undefined ? {} : { threadId }),
            ...(spans.length === 0 ? {} : { formatting: spans }),
            ...(noPreview ? { noPreview } : {}),
          }),
        undefined,
        validate === undefined || threadId === undefined
          ? undefined
          : () => validate(chatId, threadId, { ...(replyTo === undefined ? {} : { replyTo }) }),
      )
      return { operationId, chatId, saved: true }
    },

    send: async ({
      chat,
      text: typed,
      sendId,
      replyTo: typedReplyTo,
      threadId: typedThread,
      silent,
      noPreview,
      markdown,
      html,
      at,
      attachments = [],
      key,
      origin,
      spoiler,
      captionAbove,
      sendAs,
      commentTo,
      sticker,
      stickerFile,
    }) => {
      const stickers = (sticker === undefined ? 0 : 1) + (stickerFile === undefined ? 0 : 1)
      if (stickers > 0 && (stickers > 1 || typed.trim() !== "" || attachments.length > 0 || markdown || html))
        throw new CliError("validation_error", "a sticker goes alone — no text, no file, no photo")
      if (commentTo !== undefined && (typedReplyTo !== undefined || typedThread !== undefined))
        throw new CliError("validation_error", "a comment answers the post itself; not with --reply-to or --topic")
      const media = { ...(spoiler ? { spoiler } : {}), ...(captionAbove ? { captionAbove } : {}) }
      checkMediaOptions(deps.messenger, Object.keys(media) as MediaOption[], attachments.length)
      const connection = await deps.connection()
      if (at !== undefined && sendId !== undefined) {
        throw new CliError(
          "validation_error",
          "a scheduled send is never repeated: it would be scheduled twice — look in `messages scheduled` instead",
        )
      }
      const prepared = await formatted(connection, typed, { markdown, html })
      const { text, spans } = deps.agentText ? visibleFormattedText(prepared) : prepared
      if (text.trim() === "" && attachments.length === 0 && stickers === 0) {
        throw new CliError("validation_error", "nothing to send — the marks leave no text")
      }
      const threadId = threadIdOf(typedThread)
      const validate =
        threadId === undefined ? undefined : capability(connection, "validateThread", "send to a forum topic")
      const checkSendAs = sendAsCheck(connection, sendAs)
      const discussionOf =
        commentTo === undefined ? undefined : capability(connection, "discussionOf", "comment on a channel post")
      const { id: resolved } = await connection.resolve(chat)
      const discussion = discussionOf && commentTo !== undefined ? await discussionOf(resolved, commentTo) : undefined
      const chatId = discussion?.chatId ?? resolved
      const replyTo = discussion?.messageId ?? typedReplyTo
      await checkSendAs(chatId)
      const id = sendId ?? connection.newSendId?.() ?? newSendId()
      const attempt = {
        chatId,
        kind: "message" as const,
        sendId: id,
        operationId: id,
        length: text.length,
        ...(attachments.length > 1 ? { count: attachments.length } : {}),
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(sendAs === undefined ? {} : { sendAs }),
        ...(at === undefined ? {} : { scheduledFor: at }),
        ...(key === undefined ? {} : { key }),
        ...(origin === undefined ? {} : { origin }),
        ...(attachments.length === 0 && stickerFile === undefined
          ? {}
          : {
              attachments: [
                ...attachments.map(({ kind, source }) => ({ kind, bytes: uploadSize(source) })),
                ...(stickerFile === undefined
                  ? []
                  : [{ kind: "sticker" as const, bytes: uploadSize(stickerFile.source) }]),
              ],
            }),
      }
      try {
        const done = await guardedWrite(
          guard,
          attempt,
          () =>
            connection.send(chatId, text, {
              sendId: id,
              ...(replyTo === undefined ? {} : { replyTo }),
              ...(threadId === undefined ? {} : { threadId }),
              ...(silent ? { silent } : {}),
              ...(noPreview ? { noPreview } : {}),
              ...(spans.length > 0 ? { formatting: spans } : {}),
              ...(at === undefined ? {} : { at }),
              ...(attachments.length === 0 ? {} : { attachments }),
              ...(sticker === undefined ? {} : { sticker }),
              ...(stickerFile === undefined ? {} : { stickerFile }),
              ...media,
              ...(sendAs === undefined ? {} : { sendAs }),
            }),
          (sent) => sentIds(chatId, sent.message),
          validate === undefined || threadId === undefined
            ? undefined
            : () => validate(chatId, threadId, { ...(replyTo === undefined ? {} : { replyTo }) }),
        )
        return { ...done, operationId: id }
      } catch (error) {
        if (at !== undefined && codeOf(error) === "outcome_unknown") {
          throw new CliError(
            "outcome_unknown",
            "no answer — the message may have been scheduled. Look in `messages scheduled` before anything else; " +
              "never send it again with --operation-id",
            { scheduled_for: at },
          )
        }
        throw error
      }
    },

    edit: async ({ chat, message, text: typed, markdown, html }) => {
      const connection = await deps.connection()
      const edit = capability(connection, "edit", "edit a message")
      const prepared = await formatted(connection, typed, { markdown, html })
      const { text, spans } = deps.agentText ? visibleFormattedText(prepared) : prepared
      if (text.trim() === "") throw new CliError("validation_error", "no new text — the marks leave nothing")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      const edited = await guardedWrite(
        guard,
        { operationId, chatId, kind: "edit", messageId: message, length: text.length },
        () => edit(chatId, message, text, spans.length > 0 ? { formatting: spans } : {}),
      )
      return { operationId, message: edited }
    },

    delete: async ({ chat, messages, forEveryone }) => {
      const connection = await deps.connection()
      if (messages.length > DELETE_AT_ONCE) {
        throw new CliError("validation_error", `at most ${DELETE_AT_ONCE} messages at once, got ${messages.length}`)
      }
      const remove = capability(connection, "delete", "delete messages")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(guard, { operationId, chatId, kind: "delete", count: messages.length, forEveryone }, () =>
        remove(chatId, messages, { forEveryone }),
      )
      return { operationId, chatId, deleted: messages, forEveryone }
    },

    forward: async ({ chat, message, to, silent, sendId, sendAs, threadId: typedThread }) => {
      const connection = await deps.connection()
      const forward = capability(connection, "forward", "forward a message")
      const threadId = threadIdOf(typedThread)
      if (threadId !== undefined && deps.messenger.forwardTopic !== true)
        throw new CliError("validation_error", "this messenger cannot forward to a forum topic")
      const validate =
        threadId === undefined ? undefined : capability(connection, "validateThread", "forward to a forum topic")
      const checkSendAs = sendAsCheck(connection, sendAs)
      const { id: fromChatId } = await connection.resolve(chat)
      const { id: toChatId } = await connection.resolve(to)
      await checkSendAs(toChatId)
      const id = sendId ?? connection.newSendId?.() ?? newSendId()
      const forwarded = await guardedWrite(
        guard,
        {
          operationId: id,
          sendId: id,
          chatId: toChatId,
          kind: "forward",
          ...(threadId === undefined ? {} : { threadId }),
          ...(sendAs === undefined ? {} : { sendAs }),
        },
        () =>
          forward(fromChatId, message, toChatId, {
            sendId: id,
            ...(silent ? { silent } : {}),
            ...(sendAs === undefined ? {} : { sendAs }),
            ...(threadId === undefined ? {} : { threadId }),
          }),
        (done) => sentIds(toChatId, done),
        validate === undefined || threadId === undefined ? undefined : () => validate(toChatId, threadId, {}),
      )
      return { operationId: id, sendId: id, message: forwarded }
    },

    pin: ({ notify, duration, ...target }) => pinning(target, true, notify, duration),
    unpin: (target) => pinning(target, false, false),

    star: async ({ chat, message, starred }) => {
      const connection = await deps.connection()
      const star = capability(connection, "star", starred ? "star a message" : "unstar a message")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(
        guard,
        {
          operationId,
          chatId,
          kind: "account",
          action: starred ? "message-star" : "message-unstar",
          messageId: message,
        },
        () => star(chatId, message, starred),
      )
      return { operationId, chatId, messageId: message, starred }
    },

    react: async ({ chat, message, emoji }) => {
      const connection = await deps.connection()
      if (emoji === "") throw new CliError("validation_error", "which emoji? give one, for example 👍")
      const react = capability(connection, "react", "react to a message")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(guard, { operationId, chatId, kind: "reaction", messageId: message }, () =>
        react(chatId, message, emoji),
      )
      return { operationId, chatId, messageId: message, reaction: emoji }
    },
  }
}

/** The server answers for the account it runs as only; another account's message with the same ids is the archive's. */
const withServer = <T extends SearchFound>(found: T, account: AccountKey, server?: ServerStep): T =>
  server
    ? {
        ...found,
        server: server.report,
        items: found.items.map((hit) => ({
          ...hit,
          source:
            (keyOf(accountOf(hit)) === keyOf(account) && server.sources.get(sourceKey(hit.chatId, hit.id))) ||
            "archive",
        })),
      }
    : found

/** What a run is kept as: the query and options it was given. */
const paramsOf = (command: SearchCommand, query: SearchQuery & { by?: StatsGrouping }): SearchParams => ({
  ...(query.text === undefined ? {} : { text: query.text }),
  ...(query.ast === undefined ? {} : { ast: query.ast }),
  ...(query.discover === undefined ? {} : { discover: query.discover }),
  ...(query.chat === undefined ? {} : { chat: query.chat }),
  ...(query.source === undefined ? {} : { source: query.source }),
  ...(query.timezone === undefined ? {} : { timezone: query.timezone }),
  limit: query.limit,
  ...(command === "search"
    ? { newest: query.newest === true, ...(query.context === undefined ? {} : { context: query.context }) }
    : { by: query.by }),
})
const formatted = async (
  connection: MessengerAdapter,
  typed: string,
  { markdown, html }: { markdown?: boolean | undefined; html?: boolean | undefined },
): Promise<FormattedText> => {
  if (markdown && html) throw new CliError("validation_error", "--md and --html mark up the text two ways; use one")
  if (markdown) return validateFormattedText(await capability(connection, "formatMarkdown", "format Markdown")(typed))
  if (html) return validateFormattedText(await capability(connection, "formatHtml", "format HTML")(typed))
  return { text: typed, spans: [] }
}

const MEDIA_FLAGS: Record<MediaOption, string> = {
  spoiler: "--spoiler",
  captionAbove: "--caption-above",
  fileName: "--filename",
}

const checkMediaOptions = (messenger: MessengerTraits, asked: MediaOption[], attachments: number): void => {
  const [first] = asked
  if (first === undefined) return
  const missing = asked.find((one) => !messenger.mediaOptions?.includes(one))
  if (missing) throw new CliError("validation_error", `this messenger has no ${MEDIA_FLAGS[missing]}`)
  if (attachments === 0) throw new CliError("validation_error", `${MEDIA_FLAGS[first]} needs a --photo or --file`)
}
