import type { CounterField } from "../domain/counters.js"
import type { Chat, Id, Provider } from "../domain/models.js"
import type { AccountKey } from "../store/store.js"
import type { AppIdentity } from "./app.js"

export interface Fetching {
  beforeInclusive?: boolean
  /** Messages per history request. */
  page: number
  /** The most one history request returns, where the messenger is known to cap it; a larger `--page-size` is refused. */
  maxPageSize?: number
  /** The least wait between requests, as `--pause` takes it. */
  pause: string
  /** Each wait drawn between `pause` and twice that, as a person scrolls rather than a clock. */
  jitter?: boolean
  /** `messages sync` takes this many pages' worth of messages when `--limit` is not given. */
  maxPages: number
  /**
   * What a held stretch is keyed by: the message id, or its send time where ids pass 2^53 and do
   * not count messages (MAX). By time, `before` reaches the adapter as an ISO time.
   */
  orderBy?: "id" | "time"
}

/** `messages send --spoiler` and `--caption-above`. */
export type MediaOption = "spoiler" | "captionAbove" | "fileName"

/** What a messenger is and can do, as the services read it; the CLI's `Messenger` adds how its commands run. */
export interface MessengerTraits {
  counterFields?: readonly CounterField[]
  app: AppIdentity
  provider: Provider
  /** The messenger's own name, as its users write it — `Telegram`, `MAX`. Defaults to the command. */
  name?: string
  /**
   * The send options for attachments this messenger honours; none when unset, so an adapter that does not
   * know a newer option is never handed one to drop.
   */
  mediaOptions?: readonly MediaOption[]
  /**
   * Whether a pin can stay quiet, telling nobody; yes when unset. No: every pin tells the chat's members, so each
   * one counts toward the hourly limit (WhatsApp).
   */
  quietPins?: boolean
  /** How many seconds a pin may last — `messages pin --expire-time`; pins never expire when unset. */
  pinDurations?: readonly number[]
  /** Whether `messages forward --topic` forwards into a forum topic; no when unset. */
  forwardTopic?: boolean
  /** Whether folders take kinds of chat, skip muted, read or archived ones, exclude and pin chats; no when unset. */
  folderRules?: boolean
  /** Whether the messenger says when an account was made — the moderation rule `newAccount`; yes when unset. */
  knowsAccountAge?: boolean
  /**
   * This messenger's invite links, which `chats moderate` judges under `invites`. Telegram's and MAX's
   * are built in for now.
   */
  inviteLinks?: RegExp
  /** The chat `me` names, when the messenger has a notes-to-self chat. */
  savedChatId?: (account: AccountKey) => Id
  /** The other person in a one-to-one chat, when the chat says who — a recipient list matches on it. */
  partnerOf?: (chat: Chat) => Id | undefined
  /** How `messages sync` reads this messenger's history, where Telegram's defaults do not fit it. */
  fetching?: Fetching
  /**
   * Where `chats`, `messages list|context` and `contacts` read from. `store` is for a messenger that
   * pushes its history instead of answering for it: those reads answer from the local store, which
   * `serve` keeps filled, and never connect; writes still do. `server` when unset.
   */
  history?: "server" | "store"
  /**
   * With `history: "store"`: whether one chat's older history can still be asked for, page by page, through the
   * adapter's `history` — `messages sync <chat>`. `--all` stays refused: there is no chat list to walk. No when unset.
   */
  historyOnDemand?: boolean
  /**
   * Whether `search messages --backend` is offered: the adapter has `searchMessages`. `chat` when its server
   * searches one chat at a time, so only a query that names one chat asks it. No when unset.
   */
  serverSearch?: boolean | "chat"
}

/**
 * Whether `messages sync <chat>` can fill one chat, so an answer may advise it: a messenger that answers for its
 * history, or a pushed-history one with `historyOnDemand`. `--all` needs `history` other than `store`.
 */
export const syncsOneChat = (messenger: Pick<MessengerTraits, "history" | "historyOnDemand">): boolean =>
  messenger.history !== "store" || messenger.historyOnDemand === true
