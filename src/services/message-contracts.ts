import type { DownloadedFile } from "../domain/attachments.js"
import type { MessageLink } from "../domain/message-link.js"
import type { Deletion, Discussion, Id, Message, Page, Provider, WindowedMessage } from "../domain/models.js"
import type { After, Download, Sent } from "../ports/messenger.js"
import type { SkippedSource } from "../search/account-list.js"
import type { Match } from "../search/search.js"
import type { Operated } from "../sends/guarded.js"
import type { PermissionKey } from "../sends/permissions.js"
import type { UploadInput } from "../sends/upload.js"
import type { AccountKey, ChatCompleteness, MatchPlace, StoredHit } from "../store/store.js"
import type { MessageStats, QueryMetadata, SearchCoverage, StatsGrouping } from "./messages-search.js"
import type { SearchAllFound, SearchAllRequest } from "./search-all.js"
import type { SearchAllIncludingMeetingsFound, SearchAllWithMeetingsRequest } from "./search-all-meetings.js"
import type { SearchKind } from "./search-kind.js"
import type { SearchRefreshed, SyncOptions } from "./search-refresh.js"
import type { Backend, HitSource, ServerOptions, ServerSearched } from "./server-search.js"
import type { ThreadContext, ThreadOptions } from "./thread-context.js"

export interface ListWindow {
  limit: number
  before?: string
  /** Read back from this moment, epoch milliseconds. */
  beforeTime?: number
  /** Read forward from this message or moment, parsed by the caller in its own words (`afterOf`). */
  after?: After
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
  /** Strict Lucene by default; legacy discovery is explicit through language or a RegExp pattern. */
  text?: string
  discover?: boolean
  language?: "lucene" | "legacy"
  timezone?: string
  ast?: unknown
  signal?: AbortSignal
  pattern?: RegExp
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
  discovery?: { coverage: number; matchedTerms: string[]; missingTerms: string[]; parent?: string }
  match?: Match
  /** Where the words were: the text, a voice note's transcript, a file's name or a file's text. */
  matchedIn?: MatchPlace
  score?: number | null
  exact?: boolean
  source?: HitSource
  context?: WindowedMessage[]
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
  /** `false` while the word index is being built: the answer came from the substring index. */
  wordsReady: boolean
  /** The same for the stems, in strict search: `false` until a stemmed search may run. */
  stemsReady?: boolean
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
  attachments?: UploadInput[]
  /** The level it is checked against, where it is not `messages.send`: a rule's reply is `replies.send`. */
  key?: PermissionKey
  /** Who sent it, in the send journal: `rule:<id>`. */
  origin?: string
  spoiler?: boolean
  captionAbove?: boolean
  /** A sticker by id, sent alone. */
  sticker?: Id
  /** One of the ids `chats.sendAs` lists for this chat. */
  sendAs?: Id
  /** A post of `chat`, a channel: the message goes to the post's discussion as a reply to it. */
  commentTo?: Id
}

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

export interface Reacted {
  chatId: Id
  messageId: Id
  /** `null` once it is taken off. */
  reaction: string | null
}

/** Every write goes through the guard: asked before it goes, told after, on every outcome. */
export interface MessagesService {
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
  /** Counts toward the hourly limit only when it notifies. */
  pin(target: MessageTarget & { notify: boolean }): Promise<Operated<Pinned>>
  unpin(target: MessageTarget): Promise<Operated<Pinned>>
  /** `null` takes the reaction off. A reaction never counts toward the hourly limit. */
  react(target: MessageTarget & { emoji: string | null }): Promise<Operated<Reacted>>
}
