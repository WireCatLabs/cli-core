import type { TextRange } from "../conversations/chunks.js"
import type { Link } from "../conversations/link.js"
import type { Chat, ChatKind, ChatUpdate, Id, MessageHit, Provider } from "../domain/models.js"
import type * as imageChunks from "./sqlite/image-chunks.js"
import type { Where } from "./sqlite/query-filter.js"

export type PictureInput = imageChunks.PictureInput

/** Which account of which messenger a call is about. */
export interface AccountKey {
  provider: Provider
  account: Id
  scope?: "personal" | "work"
}

/** An account as the store holds it: `id` is what `meetings` and `mail` take. */
export interface StoredAccount {
  id: number
  provider: Provider
  account: Id
  name: string | null
  scope: "personal" | "work"
}

/** Whether a stored chat may hold a message deleted without naming its chat. */
export type DeletionScope = (chat: Pick<Chat, "id" | "kind" | "providerMetadata">) => boolean

/** How a message reached the store — `history`, `send`, `backfill`, `update`. Diagnostic. */
export type IngestedVia = string

export interface StoredHit extends MessageHit {
  locator: string
}

/** What a provider says about a person. `null` or absent never erases what was known. */
export interface PersonFacts {
  id: Id
  name: string | null
  username?: string | null
  isBot?: boolean | null
  description?: string | null
  /** An address the provider shows for them: they become one person with the mail contact of that exact address. */
  email?: string | null
  /** As the provider showed it, whole; only where it shows it to the owner. */
  phone?: string | null
}

/** One identity in one messenger, by the messenger's own id. `provider` is any string: `email` is one. */
export interface IdentityRef {
  provider: Provider
  id: Id
}

/** How a link was decided (`manual`, `same-email`) and who decided it (`owner`, a program's name). */
export interface LinkOptions {
  method: string
  by: string
}

export interface LinkedIdentity extends IdentityRef {
  name: string | null
  username: string | null
  isBot: boolean | null
  /** The accounts in this store that have seen it. */
  accounts: Id[]
  method: string
  linkedBy: string
  linkedAt: string
}

/** A person across messengers: `uid` stays the same however their names change. */
export interface PersonRecord {
  uid: string
  name: string | null
  identities: LinkedIdentity[]
}

/** What a search of one account's messages takes, the account given apart. */
export interface AccountMessageFilter {
  senders?: Id[]
  together?: boolean
  text?: string
  /** Only this chat of the account. */
  chatId?: Id
  /** With `perChat`, the newest `limit` of each chat rather than of all of them together. */
  limit: number
  perChat?: boolean
}

/** A chat id is one account's, so `chatId` comes only with `account`. */
export type MessageFilter = AccountMessageFilter & {
  provider?: Provider
  /** Several accounts of `provider`, by native id — a read across some of them, never all by accident. */
  accounts?: Id[]
} & ({ account: AccountKey } | { account?: undefined; chatId?: undefined })

export interface Delta {
  chats?: ChatUpdate[]
  people?: PersonFacts[]
  members?: Map<Id, Id[]>
  state?: Record<string, string>
}

/** A chat list's query, compiled over `CHAT_COLUMNS`. */
export interface StoredChatFilter {
  where?: Where
  /** Chats the account left are kept but left out of a list unless this asks for them. */
  includeLeft?: boolean
}

/** One sender's stored messages in one chat. */
export interface SenderChatStats {
  chatId: Id
  title: string | null
  kind: ChatKind
  messages: number
  firstAt: string | null
  lastAt: string | null
}

export interface ChatActivity {
  chatId: Id
  title: string | null
  kind: ChatKind
  lastMessageAt: string
  /** `null` while the newest message is not stored: the chat list says the chat moved, nothing more. */
  lastMessageId: Id | null
  /** `null` when the newest message is not stored, or the messenger did not say who sent it. */
  lastFromOwner: boolean | null
}

export interface ChatStats {
  chatId: Id
  title: string | null
  kind: ChatKind
  messages: number
  oldestAt: string | null
  newestAt: string | null
  lastStoredAt: string | null
}

/** One build of a chat's conversations, by message id; phase 3 plan C3. */
export interface ConversationBuild {
  check?: () => void
  /** When the build started reading: a change after it is not in the build. */
  startedAt: number
  algorithmVersion: number
  links: Link[]
  /** Message ids, each conversation oldest first. */
  conversations: Id[][]
  /** Each conversation's chunks, in the same order as `conversations` (phase 5). */
  chunks?: { firstId: Id; lastId: Id; hash: string; range?: TextRange }[][]
}

/**
 * A conversation found by meaning: the chunk that matched best, and how near it is (−1 to 1). `stale` when
 * the chunk's messages no longer read as they did when it was embedded (NEED-550 B).
 */
export interface ConversationHit {
  summary: ConversationSummary
  chunk: { firstMessageId: Id; lastMessageId: Id }
  score: number
  stale: boolean
  /** Set when the hit is an image, found by the text around it: its message is the chunk. */
  matchedIn?: "context"
}

export interface StoredReadiness {
  chatId: Id
  builtAt: string | null
  algorithmVersion: number | null
  /** Messages the current build has not seen. */
  pending: { new: number; edited: number; deleted: number }
  /** The current build's distinct chunk texts: `current` + `stale` + `missing`; `embedded` have any vector. */
  vectors: { chunks: number; embedded: number; current: number; stale: number; missing: number }
}

export interface ConversationSummary {
  id: string
  chatId: Id
  firstMessageId: Id
  firstAt: string
  lastAt: string
  messageCount: number
  /** How many people wrote in it. */
  senders: number
  builtAt: string
  algorithmVersion: number
}

/** One message as the user's agent sees it in a batch (phase 4 plan A4). */
export interface BatchMessage {
  id: Id
  at: string
  sender: { id: Id | null; name: string | null }
  text: string
  /** The message it answers, by the messenger's own record. */
  replyTo?: Id
  thread?: Id
  mentions?: Id[]
  /** `true`: the agent is asked which earlier message this one answers. `false`: context only. */
  answer: boolean
  /** For a message to answer: the current build's messenger and rule links, strongest first. */
  candidates?: { parent: Id | null; source: string; kind: string; confidence: number }[]
}

/** What the user's agent returns for a batch (phase 4 plan A5), as read from stdin. */
export interface AgentAnswer {
  /** The model that answered; stored as the link's method. */
  model: string
  /** The skill's version, when the skill sends it. */
  skill?: string
  answers: { message: Id; parent: Id | null; confidence: number }[]
}

/** A window of a chat for the agent: the messages to answer and the ones before them (A1). */
export interface LinkBatch {
  /** Names the window, so an answer can be checked against it (A3). */
  batch: string
  chat: Id
  messages: BatchMessage[]
  /** Messages still needing the agent after this batch, and their characters. */
  remaining: { messages: number; characters: number }
}

export interface StoredLink {
  /** `null`: the source says the message starts a conversation. */
  parentId: Id | null
  source: "provider" | "rule" | "agent"
  kind: string
  confidence: number
  method: string
  version: string | null
  createdAt: string
  /** An end changed after the link was written; it is not chosen. */
  stale: boolean
}

export interface Range {
  from: number
  to: number
}
