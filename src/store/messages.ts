import type { CounterObservations } from "../domain/counters.js"
import type { Id, Message, Page, PollVote, Reactions, WindowedMessage } from "../domain/models.js"
import { keysOver } from "./keys.js"
import { applyCounterObservations } from "./sqlite/counters.js"
import { type DocumentLinkMessage, documentLinkMessages } from "./sqlite/document-links.js"
import * as messageWrites from "./sqlite/messages.js"
import type { StoreContext } from "./sqlite/open.js"
import * as personLinks from "./sqlite/person-links.js"
import * as reads from "./sqlite/reads.js"
import * as search from "./sqlite/search.js"
import { write } from "./sqlite/transaction.js"
import * as transcripts from "./sqlite/transcripts.js"
import type { AccountKey, DeletionScope, IngestedVia, MessageFilter, SenderChatStats, StoredHit } from "./types.js"

export interface AccountMessages {
  /**
   * A scheduled message is not kept: it is not history yet.
   *
   * `seenAt` is when the messenger was asked: a message it still returned is not deleted, so a
   * tombstone older than that is lifted. A tombstone set after it stays — the deletion is newer.
   */
  saveMessages(
    key: AccountKey,
    chatId: Id,
    messages: Message[],
    options: { via: IngestedVia; seenAt?: number },
  ): Promise<void>
  /** Oldest to newest, like a provider's history page. */
  /** `threadId` keeps one forum topic's; `outgoing` only the owner's (true) or only the others' (false). */
  messages(
    key: AccountKey,
    chatId: Id,
    window: { limit: number; before?: Id; since?: string; threadId?: Id; outgoing?: boolean },
  ): Promise<Page<Message>>
  /** How many stored messages the chat has, sent at `since` or later when it is given. */
  countMessages(key: AccountKey, chatId: Id, options?: { since?: string }): Promise<number>
  /** Saved or edited after `at` (ISO, this machine's clock), oldest first, and the ids deleted after it. */
  changes(key: AccountKey, chatId: Id, at: string): Promise<{ messages: Message[]; deleted: Id[] }>
  /**
   * By time rather than by id: `before` messages sent at `at` or earlier and `after` sent later,
   * oldest first. `around` answers the same question for a message id.
   */
  messagesWindow(key: AccountKey, chatId: Id, window: { at: string; before: number; after: number }): Promise<Message[]>
  /**
   * A stored message and its stored neighbours, oldest first, the one asked for with `anchor`. Until
   * backfill records which stretches are complete, a neighbour here is the nearest one kept, not
   * necessarily the next one sent.
   */
  around(
    key: AccountKey,
    chatId: Id,
    messageId: Id,
    window: { before: number; after: number },
  ): Promise<WindowedMessage[]>
  /**
   * One message by its id. Without `chatId` it is looked up across the account, which is enough
   * where ids are unique per account (MAX) and refused where two chats share one (Telegram).
   */
  message(key: AccountKey, messageId: Id, options?: { chatId?: Id }): Promise<Message | undefined>
  /**
   * A tombstone, not a removal: the row stays, so a copy fetched before the deletion does not bring
   * the message back, and reads and search stop returning it. Its text goes — from the row, the
   * search copy, the edit history and the transcript. Only the messenger returning it again, when
   * asked after the deletion, lifts the tombstone (`saveMessages`' `seenAt`).
   *
   * Without `chatId`, a message is tombstoned only when exactly one live message with its id is left
   * in the chats `among` accepts. Without `among`, nothing is: only the messenger knows which of its
   * chats a deletion without one may belong to (`Messenger.deletedWithoutChat`).
   */
  markDeleted(key: AccountKey, messageIds: Id[], options?: { chatId?: Id; among?: DeletionScope }): Promise<number>
  /** A message's reactions as they are now; answers whether the message is held at all. */
  saveReactions(
    key: AccountKey,
    chatId: Id,
    messageId: Id,
    reactions: Reactions,
    options?: { observation?: CounterObservations["reactions"] },
  ): Promise<boolean>
  /** One voter's vote in the poll a message carries, unless the store holds a newer one of theirs; no answers is a take-back. */
  saveVote(key: AccountKey, chatId: Id, messageId: Id, vote: PollVote): Promise<void>
  /** Each voter's newest vote in the poll a message carries, newest first. */
  pollVotes(key: AccountKey, chatId: Id, messageId: Id): Promise<PollVote[]>
  /** One person's stored messages per chat of this account, newest first. */
  senderStats(key: AccountKey, senderId: Id): Promise<SenderChatStats[]>
  /** What a voice message said, when it was heard before, and by what. */
  transcript(key: AccountKey, chatId: Id, messageId: Id): Promise<{ text: string; source: string } | undefined>
  /** Keeps a finished transcript; an empty one is not kept, so the message is heard again. */
  keepTranscript(key: AccountKey, chatId: Id, messageId: Id, text: string, source: string): Promise<void>
  /** The chat's messages that may hold a Google document link, newest first, with the documents linked from each. */
  documentLinkMessages(key: AccountKey, chatId: Id): Promise<DocumentLinkMessage[]>
  /** Messages of the account that name this person, newest first. */
  mentioning(key: AccountKey, person: { id: Id; username: string | null }, limit: number): Promise<Page<StoredHit>>
}

export interface MessagesStore extends AccountMessages {
  /** Newest first. At least three characters: a trigram index answers a shorter query with nothing. */
  search(query: string, options: { limit: number; account?: AccountKey }): Promise<Page<StoredHit>>
  /**
   * Newest first — by text, by who wrote it, or both. At least `text` or `senders`.
   *
   * `together` keeps only the chats where **every** sender has a message in this store — written
   * there, as far as this copy knows, which is not the same as being a member.
   */
  find(filter: MessageFilter): Promise<Page<StoredHit>>
  directReplies(parents: { account: AccountKey; chatId: Id; id: Id }[], limit: number): Promise<Page<StoredHit>>
}

export const accountMessagesOver = (context: StoreContext): AccountMessages => {
  const { database } = context
  const { accountPk, findAccountPk, findChatPk, chatKeyOf, chatPkFor, upsertMessage } = keysOver(context)
  return {
    saveMessages: async (key, chatId, messages, { via, seenAt }) =>
      write(database, () => {
        const accountKey = accountPk(key)
        const chatKey = chatPkFor(accountKey, chatId)
        for (const message of messages) {
          if (message.scheduledFor === undefined) upsertMessage(key, accountKey, chatKey, message, via, seenAt)
        }
      }),

    messages: async (key, chatId, window) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? { items: [], hasMore: false } : reads.messagePage(context, chatKey, window)
    },

    countMessages: async (key, chatId, { since } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? 0 : reads.countMessages(context, chatKey, since)
    },

    changes: async (key, chatId, at) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? { messages: [], deleted: [] }
        : reads.changesSince(context, chatKey, Date.parse(at))
    },

    messagesWindow: async (key, chatId, window) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : reads.messagesWindow(context, chatKey, window)
    },

    around: async (key, chatId, messageId, window) => reads.around(context, chatKeyOf(key, chatId), messageId, window),

    message: async (key, messageId, { chatId } = {}) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? undefined : reads.message(context, accountKey, messageId, chatId)
    },

    markDeleted: async (key, messageIds, { chatId, among } = {}) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined || messageIds.length === 0) return 0
      let changed = 0
      write(database, () => {
        changed = messageWrites.markDeleted(context, accountKey, messageIds, chatId, among)
      })
      return changed
    },

    saveReactions: async (key, chatId, messageId, reactions, options = {}) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      if (chatKey === undefined) return false
      let saved = false
      write(database, () => {
        saved = messageWrites.saveReactions(context, chatKey, messageId, reactions)
        const row = database
          .prepare("SELECT id AS pk FROM messages WHERE chat_id=? AND external_id=? AND deleted_at IS NULL")
          .get(chatKey, messageId)
        if (row && options.observation)
          applyCounterObservations(context, Number(row.pk), { reactions: options.observation })
      })
      return saved
    },

    saveVote: async (key, chatId, messageId, vote) =>
      write(database, () => {
        const accountKey = accountPk(key)
        messageWrites.saveVote(context, accountKey, key.provider, chatPkFor(accountKey, chatId), messageId, vote)
      }),

    pollVotes: async (key, chatId, messageId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : messageWrites.pollVotes(context, chatKey, messageId)
    },

    senderStats: async (key, senderId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : reads.senderStats(context, accountKey, key.provider, senderId)
    },

    transcript: async (key, chatId, messageId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? undefined : transcripts.transcript(context, chatKey, messageId)
    },

    keepTranscript: async (key, chatId, messageId, text, source) => {
      if (text.trim() === "") return
      write(database, () =>
        transcripts.keepTranscript(context, chatPkFor(accountPk(key), chatId), messageId, text, source),
      )
    },

    documentLinkMessages: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : documentLinkMessages(context, chatKey)
    },

    mentioning: async (key, person, limit) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined
        ? { items: [], hasMore: false }
        : personLinks.mentioning(context, accountKey, person, limit)
    },
  }
}

export const messagesStoreOver = (context: StoreContext, keyed: AccountMessages): MessagesStore => ({
  ...keyed,
  search: async (query, { limit, account }) =>
    search.find(context, { text: query, limit, ...(account ? { account } : {}) }),
  find: async (filter) => search.find(context, filter),
  directReplies: async (parents, limit) => search.directReplies(context, parents, limit),
})
