import type { AppIdentity } from "../domain/application.js"
import type { AdminRight, Chat, GroupSettings, Id, Provider } from "../domain/models.js"
import type { PaceRate } from "../sends/pace.js"
import type { AccountKey, DeletionScope } from "../store/store.js"

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

export type MediaOption = "spoiler" | "captionAbove" | "fileName"

export interface ProviderDescription {
  counterFields?: readonly import("../domain/counters.js").CounterField[]

  app: AppIdentity

  provider: Provider

  /** The messenger's own name, as its users write it — `Telegram`, `MAX`. Defaults to the command. */
  name?: string

  /** How fast one profile may ask the messenger, across processes, unless `requestsPerMinute` says otherwise. */
  pace?: PaceRate

  /** The group settings this messenger has, as `chats update` offers them; every one when unset. */
  groupSettings?: readonly (keyof GroupSettings)[]

  /**
   * The send options for attachments this messenger honours; none when unset, so an adapter that does not
   * know a newer option is never handed one to drop.
   */
  mediaOptions?: readonly MediaOption[]

  /** Whether `polls create` makes quizzes (`--quiz --correct --solution`); no when unset. */
  pollQuiz?: boolean

  /** How many seconds after sending a poll may close by itself — `polls create --close-time`; none when unset. */
  pollCloseSeconds?: readonly [min: number, max: number]

  /** Whether `polls voters` lists who voted for what; no when unset. */
  pollVoters?: boolean

  /** Whether `topics show` reads one forum topic; no when unset. */
  topicShow?: boolean

  /** Whether `messages forward --topic` forwards into a forum topic; no when unset. */
  forwardTopic?: boolean

  /** Whether folders take kinds of chat, skip muted, read or archived ones, exclude and pin chats; no when unset. */
  folderRules?: boolean

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

  /** Whether invite links can be listed; yes when unset. */
  inviteLinkList?: boolean

  /** Whether one invite link can be revoked; yes when unset. */
  inviteLinkRevoke?: boolean

  /** Whether one invite link can be changed — `chats link update`; no when unset. */
  inviteLinkUpdate?: boolean

  /** Whether the messenger says when an account was made — the moderation rule `newAccount`; yes when unset. */
  knowsAccountAge?: boolean

  /**
   * This messenger's invite links, which `chats moderate` judges under `invites`. Telegram's and MAX's
   * are built in for now.
   */
  inviteLinks?: RegExp

  /** Whether people added can be shown the messages from before they came — `members add --history`; yes when unset. */
  addsWithHistory?: boolean

  /** The admin rights this messenger has, as `admins add --can` offers them; every one when unset. */
  adminRights?: readonly AdminRight[]

  /** The chat `me` names, when the messenger has a notes-to-self chat. */
  savedChatId?: (account: AccountKey) => Id

  /** The other person in a one-to-one chat, when the chat says who — a recipient list matches on it. */
  partnerOf?: (chat: Chat) => Id | undefined

  /**
   * Whether a stored chat may hold a message the messenger deleted without naming its chat. When
   * unset, the store applies Telegram's rule.
   */
  deletedWithoutChat?: DeletionScope

  /** How `messages sync` reads this messenger's history, where Telegram's defaults do not fit it. */
  fetching?: Fetching

  /**
   * Where `chats`, `messages list|context` and `contacts` read from. `store` is for a messenger that
   * pushes its history instead of answering for it: those reads answer from the local store, which
   * `serve` keeps filled, and never connect; writes still do. `server` when unset.
   */
  history?: "server" | "store"

  /** Whether the messenger computes a chat's statistics for its admins — `stats chats official`; no when unset. */
  officialStats?: boolean

  /**
   * Whether `search messages --backend` is offered: the adapter has `searchMessages`. `chat` when its server
   * searches one chat at a time, so only a query that names one chat asks it. No when unset.
   */
  serverSearch?: boolean | "chat"

  /** Whether this CLI's background service fetches tracked rosters daily; true when unset. */
  tracksMembers?: boolean

  /** Speech model ids, most suitable first, for `messages transcribe --local`; the first is the default. */
  speechModels?: readonly string[]
  fileBackedUploads?: boolean
  topicOptions?: Partial<Record<"list" | "send" | "markRead" | "pollCreate", boolean>>
  topics?: boolean
  comments?: boolean
  commaSeparatedMessageIds?: boolean
}
