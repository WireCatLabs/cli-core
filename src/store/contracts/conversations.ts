import type { LinkInput } from "../../conversations/link.js"
import type { Id, Message, Page } from "../../domain/models.js"
import type { QueryExecution } from "../../search/lucene/resolved.js"
import type { ConversationEligibility } from "./conversation-eligibility-types.js"
import type {
  AccountKey,
  AgentAnswer,
  ConversationBuild,
  ConversationHit,
  ConversationSummary,
  LinkBatch,
  StoredLink,
  StoredReadiness,
} from "./models.js"
import type { ChunkToEmbed } from "./vectors-types.js"

export interface ConversationsStore {
  /** A chat's live messages for the conversation rules, oldest first; pass `next` back as `after`. */
  linkInputs(
    key: AccountKey,
    chatId: Id,
    page: { after?: string; limit: number },
  ): Promise<{ items: LinkInput[]; next: string | null }>

  /** Who wrote in the chat, by lowercased username: what an `@mention` names. */
  senderHandles(key: AccountKey, chatId: Id): Promise<Map<string, Id>>

  /**
   * The chat's provider and rule links and its conversations, rebuilt: written as a new build in short
   * transactions and made current in one, so readers never see half of it and a failed build changes nothing.
   */
  replaceConversations(key: AccountKey, chatId: Id, build: ConversationBuild): Promise<void>

  /** Newest first; `after` and `before` bound when a conversation started. */
  conversations(
    key: AccountKey,
    chatId: Id,
    window: { limit: number; after?: string; before?: string },
  ): Promise<Page<ConversationSummary>>

  /** Its messages oldest first; `undefined` when the account has no such conversation. */
  conversation(key: AccountKey, id: string): Promise<{ summary: ConversationSummary; messages: Message[] } | undefined>

  /** Which conversation a message is in, once the chat is built. */
  conversationOf(key: AccountKey, chatId: Id, messageId: Id): Promise<string | undefined>

  /** The conversation of the current build each message is in, in the same order; `undefined` where none. */
  conversationsOfMessages(
    key: AccountKey,
    refs: { chatId: Id; messageId: Id }[],
  ): Promise<(ConversationSummary | undefined)[]>

  /** Every link a message has, the messenger's first. */
  links(key: AccountKey, chatId: Id, messageId: Id, options?: { limit: number }): Promise<StoredLink[]>

  replies?(key: AccountKey, chatId: Id, messageId: Id, limit: number): Promise<Page<{ messageId: Id }>>

  /** The user's agent's current answer per message: its parent, or `null` for "starts a conversation". */
  agentAnswers(key: AccountKey, chatId: Id): Promise<Map<Id, Id | null>>

  /** Stores the agent's answer to a batch, checked whole first; answers how many were stored (A5). */
  saveAnswers(key: AccountKey, batch: string, answer: AgentAnswer): Promise<{ chat: Id; stored: number }>

  /** Drops the agent's answers for a chat, or one model's; answers how many. Messages are never touched. */
  clearAnswers(key: AccountKey, chatId: Id, model?: string): Promise<number>

  /** How many messages still need the user's agent, and their characters (phase 4). */
  batchStatus(key: AccountKey, chatId: Id): Promise<{ messages: number; characters: number }>

  /** The earliest window holding a message the agent has not answered; `undefined` when none is left. */
  nextBatch(key: AccountKey, chatId: Id, options: { size: number }): Promise<LinkBatch | undefined>

  /** Chunks of the chat's current build with no vector of `model`, by hash after `after` (phase 5). */
  chunksToEmbed(
    key: AccountKey,
    chatId: Id,
    model: string,
    options: { after?: string; limit: number },
  ): Promise<ChunkToEmbed[]>

  saveVectors(model: string, dims: number, vectors: { hash: string; vector: Float32Array }[]): Promise<void>

  /** The current build's distinct chunks, and how many have a vector of `model`. */
  vectorStatus(key: AccountKey, chatId: Id, model: string): Promise<{ chunks: number; embedded: number }>

  /** Drops the chat's vectors, or one model's; a vector another chat's chunk shares stays. */
  clearVectors(key: AccountKey, chatId: Id, model?: string): Promise<number>

  /** The conversations nearest in meaning to `query`, in one chat or every one of the account, best first. */
  nearestConversations(
    key: AccountKey,
    options: {
      chatId?: Id
      model: string
      since?: string
      limit: number
      query: Float32Array
      exclude?: string
      conversations?: string[]
      scope?: "personal" | "work"
      projectId?: string
      personId?: string
      before?: string
    },
  ): Promise<ConversationHit[]>

  /**
   * A conversation of the current build: how many chunks it has, and the vectors of `model` of those whose
   * messages did not change since — none when it is not the account's or not current.
   */
  conversationVectors(key: AccountKey, id: string, model: string): Promise<{ chunks: number; vectors: Float32Array[] }>

  /**
   * How fresh each built chat's conversations and `model`'s vectors are — one chat, or every chat whose
   * conversations were ever built. A chat never built answers `builtAt: null`.
   */
  readiness(key: AccountKey, options: { chatId?: Id; model: string }): Promise<StoredReadiness[]>

  /** Group chats with stored messages whose conversations were never built, the newest message first. */
  unbuiltGroups(key: AccountKey): Promise<Id[]>

  /** Chats in scope embedded with another model and not with `model`, which a search with it cannot see. */
  embeddedOnlyElsewhere(key: AccountKey, options: { chatId?: Id; model: string }): Promise<Id[]>

  /** Whether the chat's conversations were built, and when; `undefined` when never. */
  conversationState(
    key: AccountKey,
    chatId: Id,
  ): Promise<{ enabledAt: string; builtAt: string | null; algorithmVersion: number | null } | undefined>

  conversationEligibility?(execution: QueryExecution): Promise<ConversationEligibility>
}
