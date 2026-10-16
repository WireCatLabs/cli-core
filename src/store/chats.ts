import { CliError } from "@wirecat/cli-base"
import type { ChannelTagMatch } from "../domain/channel-tags.js"
import type { Chat, Id, Page } from "../domain/models.js"
import { keysOver } from "./keys.js"
import type { ChatMetadata } from "./sqlite/chats.js"
import * as chatQueries from "./sqlite/chats.js"
import type { ChatCompleteness } from "./sqlite/completeness.js"
import * as completeness from "./sqlite/completeness.js"
import type { StoreContext } from "./sqlite/open.js"
import type { Where } from "./sqlite/query-filter.js"
import * as reads from "./sqlite/reads.js"
import { write } from "./sqlite/transaction.js"
import type { AccountKey, ChatActivity, ChatStats, StoredChatFilter } from "./types.js"

export interface ChatsStore {
  saveChats(key: AccountKey, chats: Chat[]): Promise<void>
  /** Newest first. `query` matches three letters or more of a title; `unread` keeps chats with unread messages. */
  chats(key: AccountKey, window: { limit?: number; offset?: number } & StoredChatFilter): Promise<Page<Chat>>
  countChats(key: AccountKey, filter?: StoredChatFilter): Promise<number>
  /** The chats a person is in, newest first — as far as the saved member lists go. */
  chatsWith(key: AccountKey, memberId: Id): Promise<Chat[]>
  /**
   * Given every chat the account is in, marks the rest `left` and says how many it marked. Only
   * ever from a complete list: a page or a cut list says nothing about the chats it leaves out.
   * Remembers when, so a search can say the store knows the account's whole chat list.
   */
  markChatsLeft(key: AccountKey, present: Id[]): Promise<number>
  /** The chats marked left and the messages they hold; with `clear`, deletes them and all under them. */
  leftChats(key: AccountKey, options?: { clear?: boolean }): Promise<{ chats: number; messages: number }>
  /** Per chat: whether its history is held up to date, without gaps, back to its start. */
  chatCompleteness(key: AccountKey, chatIds: Id[]): Promise<ChatCompleteness[]>
  /** Per chat that has messages: how many, the oldest and newest, and when the last one was stored. */
  chatStats(key: AccountKey, chatId?: Id): Promise<ChatStats[]>
  /** Per chat that spoke since `since` (ms): its newest message and who sent it when stored, never the text. */
  /** `where` is a `tasks agenda` query compiled over `AGENDA_COLUMNS`. */
  chatActivity(
    key: AccountKey,
    since: number,
    where?: Where,
  ): Promise<{ chats: ChatActivity[]; storedAt: string | null }>
  chatMetadata(key: AccountKey, chatId: Id): Promise<ChatMetadata | undefined>
  saveChatMetadata(key: AccountKey, entry: Omit<ChatMetadata, "fetchedAt">): Promise<ChatMetadata>
  replaceAutoTags(key: AccountKey, chatId: Id, algorithm: string, tags: ChannelTagMatch[]): Promise<void>
  rankingDiscussionChats(account: AccountKey, chatId: string): Promise<string[]>
}

export const chatsStoreOver = (context: StoreContext): ChatsStore => {
  const { database } = context
  const { accountPk, findAccountPk, writeState } = keysOver(context)
  return {
    saveChats: async (key, list) =>
      write(database, () => {
        const accountKey = accountPk(key)
        for (const chat of list) chatQueries.upsertChat(context, accountKey, chat)
      }),

    chats: async (key, window) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined
        ? { items: [], hasMore: false }
        : chatQueries.listChats(context, accountKey, window)
    },

    countChats: async (key, filter = {}) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? 0 : chatQueries.countChats(context, accountKey, filter)
    },

    chatsWith: async (key, memberId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : chatQueries.chatsWith(context, accountKey, key, memberId)
    },

    markChatsLeft: async (key, present) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return 0
      let marked = 0
      write(database, () => {
        marked = chatQueries.markLeft(context, accountKey, present)
        writeState(accountKey, completeness.CHAT_LIST_KEY, String(present.length))
      })
      return marked
    },

    leftChats: async (key, { clear = false } = {}) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return { chats: 0, messages: 0 }
      let found = { pks: [] as number[], messages: 0 }
      write(database, () => {
        found = chatQueries.leftChats(context, accountKey)
        if (clear) chatQueries.purgeChats(context, found.pks)
      })
      return { chats: found.pks.length, messages: found.messages }
    },

    chatCompleteness: async (key, chatIds) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : completeness.chatCompleteness(context, accountKey, chatIds)
    },

    chatStats: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : reads.chatStats(context, accountKey, chatId)
    },

    chatActivity: async (key, since, where) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined
        ? { chats: [], storedAt: null }
        : reads.chatActivity(context, accountKey, since, where)
    },

    chatMetadata: async (key, chatId) => chatQueries.metadata(context, key, chatId),
    saveChatMetadata: async (key, entry) => chatQueries.saveMetadata(context, key, entry),
    replaceAutoTags: async (key, chatId, algorithm, matches) =>
      write(database, () => chatQueries.replaceAutoTags(context, key, chatId, algorithm, matches)),

    rankingDiscussionChats: async (account, chatId) => {
      const rows = database
        .prepare(
          "SELECT DISTINCT json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END,'$.graph.discussionChatId') AS id FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id WHERE ac.provider=? AND ac.external_id=? AND c.external_id=? AND c.kind='channel' AND m.deleted_at IS NULL AND json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END,'$.graph.version')=1 AND json_type(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END,'$.graph.discussionChatId')='text' LIMIT 101",
        )
        .all(account.provider, account.account, chatId)
      if (rows.length > 100)
        throw new CliError("validation_error", "too many linked discussion groups — narrow the channel scope")
      return rows.map(({ id }) => String(id))
    },
  }
}
