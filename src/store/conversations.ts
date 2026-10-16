import { CliError } from "@wirecat/cli-base"
import type { LinkInput } from "../conversations/link.js"
import type { Id, Message, Page } from "../domain/models.js"
import { keysOver } from "./keys.js"
import * as batches from "./sqlite/batches.js"
import * as chatQueries from "./sqlite/chats.js"
import * as conversationQueries from "./sqlite/conversations.js"
import type { StoreContext } from "./sqlite/open.js"
import type { Where } from "./sqlite/query-filter.js"
import { write } from "./sqlite/transaction.js"
import type { AccountKey, AgentAnswer, ConversationBuild, ConversationSummary, LinkBatch, StoredLink } from "./types.js"

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
  /** Newest first; `where` is a list query compiled over `CONVERSATION_COLUMNS`. */
  conversations(
    key: AccountKey,
    chatId: Id,
    window: { limit: number; offset?: number; where?: Where },
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
  replies(key: AccountKey, chatId: Id, messageId: Id, limit: number): Promise<Page<{ messageId: Id }>>
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
  /** Whether the chat's conversations were built, and when; `undefined` when never. */
  conversationState(
    key: AccountKey,
    chatId: Id,
  ): Promise<{ enabledAt: string; builtAt: string | null; algorithmVersion: number | null } | undefined>
}

export const conversationsStoreOver = (context: StoreContext): ConversationsStore => {
  const { database } = context
  const { findAccountPk, findChatPk, chatKeyOf } = keysOver(context)
  return {
    linkInputs: async (key, chatId, page) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? { items: [], next: null } : conversationQueries.linkInputs(context, chatKey, page)
    },

    senderHandles: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? new Map() : conversationQueries.senderHandles(context, chatKey)
    },

    replaceConversations: async (key, chatId, build) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined) throw new CliError("not_found", `chat ${chatId} is not in the local copy`)
      await conversationQueries.replaceConversations(context, chatKey, build)
    },

    conversations: async (key, chatId, window) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? { items: [], hasMore: false }
        : conversationQueries.conversationPage(context, chatKey, window)
    },

    conversation: async (key, id) => {
      const accountKey = findAccountPk(key)
      const pk = Number(id)
      return accountKey === undefined || !Number.isSafeInteger(pk)
        ? undefined
        : conversationQueries.conversation(context, accountKey, pk)
    },

    conversationOf: async (key, chatId, messageId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? undefined : conversationQueries.conversationOf(context, chatKey, messageId)
    },

    conversationsOfMessages: async (key, refs) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return refs.map(() => undefined)
      const pks = refs.map(({ chatId, messageId }) => {
        const chatKey = findChatPk(accountPk, chatId)
        const id = chatKey === undefined ? undefined : conversationQueries.conversationOf(context, chatKey, messageId)
        return id === undefined ? undefined : Number(id)
      })
      const found = conversationQueries.summariesOf(
        context,
        accountPk,
        pks.filter((pk) => pk !== undefined),
      )
      return pks.map((pk) => (pk === undefined ? undefined : found.get(pk)))
    },

    links: async (key, chatId, messageId, options) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : conversationQueries.linksOf(context, chatKey, messageId, options?.limit)
    },

    replies: async (key, chatId, messageId, limit) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? { items: [], hasMore: false }
        : conversationQueries.repliesTo(context, chatKey, messageId, limit)
    },

    agentAnswers: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? new Map() : conversationQueries.agentAnswers(context, chatKey)
    },

    saveAnswers: async (key, batch, answer) => {
      const chatKey = batches.chatOfBatch(batch)
      const accountKey = findAccountPk(key)
      const chat =
        chatKey === undefined || accountKey === undefined ? undefined : chatQueries.chatOf(context, accountKey, chatKey)
      if (chatKey === undefined || chat === undefined) {
        throw new CliError("validation_error", `the answer was not stored: ${batch} is not a batch of this account`)
      }
      let stored = 0
      write(database, () => {
        stored = batches.saveAnswers(context, batch, answer)
      })
      return { chat, stored }
    },

    clearAnswers: async (key, chatId, model) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined) return 0
      let cleared = 0
      write(database, () => {
        cleared = batches.clearAnswers(context, chatKey, model)
      })
      return cleared
    },

    batchStatus: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? { messages: 0, characters: 0 } : batches.batchStatus(context, chatKey)
    },

    nextBatch: async (key, chatId, { size }) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined) return undefined
      const found = batches.nextBatch(context, chatKey, chatId, size)
      if (!found) return undefined
      const answered = found.messages.filter(({ answer }) => answer)
      const left = batches.batchStatus(context, chatKey)
      return {
        ...found,
        remaining: {
          messages: left.messages - answered.length,
          characters: left.characters - answered.reduce((sum, { text }) => sum + [...text].length, 0),
        },
      }
    },

    conversationState: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? undefined : conversationQueries.stateOf(context, chatKey)
    },
  }
}
