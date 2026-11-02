import { CliError } from "@wirecat/cli-base"
import type { ChannelTagMatch } from "../domain/channel-tags.js"
import type { Chat, ChatKind, ChatUpdate, Id, Page } from "../domain/models.js"
import type { HistorySkip } from "../services/history-limits.js"
import { keysOver } from "./keys.js"
import { type ChatRekey, type ChatRekeys, rekeyChat, rekeyChats } from "./sqlite/chat-rekey.js"
import type { ChatMetadata, LeftChat } from "./sqlite/chats.js"
import * as chatQueries from "./sqlite/chats.js"
import type { ChatCompleteness } from "./sqlite/completeness.js"
import * as completeness from "./sqlite/completeness.js"
import type { ChatHistoryShape, StoredHistorySkip } from "./sqlite/history-skips.js"
import * as history from "./sqlite/history-skips.js"
import type { StoreContext } from "./sqlite/open.js"
import type { Where } from "./sqlite/query-filter.js"
import * as reads from "./sqlite/reads.js"
import { write } from "./sqlite/transaction.js"
import type { AccountKey, ChatActivity, ChatStats, StoredChatFilter } from "./types.js"

export type { LeftChat }

/** The chats marked left: how many, the messages they hold, and each one. */
export interface LeftChats {
  chats: number
  messages: number
  left: LeftChat[]
}

export interface ChatsStore {
  saveChats(key: AccountKey, chats: ChatUpdate[]): Promise<void>
  /** Newest first. `query` matches three letters or more of a title; `unread` keeps chats with unread messages. */
  chats(key: AccountKey, window: { limit?: number; offset?: number } & StoredChatFilter): Promise<Page<Chat>>
  countChats(key: AccountKey, filter?: StoredChatFilter): Promise<number>
  /** The chats a person is in, newest first — as far as the saved member lists go. */
  chatsWith(key: AccountKey, memberId: Id): Promise<Chat[]>
  /**
   * Given every chat the account is in, marks the rest `left`, takes the mark off those it names, and says how many
   * it marked. Only ever from a complete list: a page or a cut list says nothing about the chats it leaves out.
   * Remembers when, so a search can say the store knows the account's whole chat list.
   */
  markChatsLeft(key: AccountKey, present: Id[]): Promise<number>
  /**
   * Takes the `left` mark off the chats a messenger's own chat list names, from any page of it: the list holds only
   * chats the account is in. Other states are kept. Says how many it took the mark off.
   */
  rejoinChats(key: AccountKey, present: Id[]): Promise<number>
  /**
   * The chat the messenger now names `to` instead of `from`: renamed, or merged into the chat already stored as
   * `to`, with `from` recorded in `chat_revisions` (`renamedChatId`), also when only `to` is stored. Replaying it
   * changes nothing.
   */
  rekeyChat(key: AccountKey, from: Id, to: Id): Promise<ChatRekey>
  /**
   * `rekeyChat` for a run of pairs, in order, in one transaction that ends once it has held the write lock for
   * `lockMs`: `taken` says how many it got to. A pair refused is in `refused`, and the others still apply.
   */
  rekeyChats(key: AccountKey, pairs: readonly { from: Id; to: Id }[], lockMs: number): Promise<ChatRekeys>
  /**
   * The chats marked left and the messages they hold, each named in `left`; with `clear`, deletes them and all under
   * them — `left` is then what was deleted.
   */
  leftChats(key: AccountKey, options?: { clear?: boolean }): Promise<LeftChats>
  /** Per chat: whether its history is held up to date, without gaps, back to its start. */
  chatCompleteness(key: AccountKey, chatIds: Id[]): Promise<ChatCompleteness[]>
  /** Per chat that has messages: how many, the oldest and newest, and when the last one was stored. */
  chatStats(key: AccountKey, chatId?: Id): Promise<ChatStats[]>
  /**
   * The id a chat re-keyed from `chatId` has now, from `chat_revisions`; `undefined` while a chat is stored under
   * `chatId` itself. Only for finding the chat: the old id and its history are never shown or searched.
   */
  renamedChatId(key: AccountKey, chatId: Id): Promise<Id | undefined>
  /** Per stored chat: its kind, how many people, and whether the owner lifted its history limits. */
  historyShapes(key: AccountKey, chatIds: Id[]): Promise<Map<Id, ChatHistoryShape>>
  /** Adds what the history limits left out of pushed history, per chat. */
  recordHistorySkips(key: AccountKey, skips: Map<Id, HistorySkip>): Promise<void>
  /** Lifts the history limits for one chat, or puts them back; `false` when the store does not know the chat. */
  setHistoryIncluded(key: AccountKey, chatId: Id, included: boolean): Promise<boolean>
  /** Every chat whose pushed history the limits left out, most messages first. */
  historySkips(key: AccountKey): Promise<StoredHistorySkip[]>
  /** A stored chat's kind, with or without messages; `undefined` when the store does not know the chat. */
  chatKind(key: AccountKey, chatId: Id): Promise<ChatKind | undefined>
  /** A stored chat's title, with or without messages; `null` when it has none or the store does not know the chat. */
  chatTitle(key: AccountKey, chatId: Id): Promise<string | null>
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
        chatQueries.revisedBy(context, "chats", () => {
          for (const chat of list) chatQueries.upsertChat(context, accountKey, chat)
        })
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
        marked = chatQueries.revisedBy(context, "left", () => chatQueries.markLeft(context, accountKey, present))
        writeState(accountKey, completeness.CHAT_LIST_KEY, String(present.length))
      })
      return marked
    },

    rejoinChats: async (key, present) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined
        ? 0
        : write(database, () =>
            chatQueries.revisedBy(context, "rejoin", () => chatQueries.rejoin(context, accountKey, present)),
          )
    },

    rekeyChat: async (key, from, to) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return { outcome: "unchanged", messages: 0, duplicates: 0 }
      return write(database, () => rekeyChat(context, key, accountKey, from, to))
    },

    rekeyChats: async (key, pairs, lockMs) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) {
        const rekey = { outcome: "unchanged", messages: 0, duplicates: 0 } as const
        return { taken: pairs.length, applied: pairs.map((pair) => ({ ...pair, rekey })), refused: [] }
      }
      return write(database, () => rekeyChats(context, key, accountKey, pairs, lockMs))
    },

    leftChats: async (key, { clear = false } = {}) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return { chats: 0, messages: 0, left: [] }
      let found: ReturnType<typeof chatQueries.leftChats> = { pks: [], chats: [], messages: 0 }
      write(database, () => {
        found = chatQueries.leftChats(context, accountKey)
        if (clear) chatQueries.purgeChats(context, found.pks)
      })
      return { chats: found.pks.length, messages: found.messages, left: found.chats }
    },

    chatCompleteness: async (key, chatIds) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : completeness.chatCompleteness(context, accountKey, chatIds)
    },

    chatStats: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : reads.chatStats(context, accountKey, chatId)
    },

    renamedChatId: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? undefined : chatQueries.renamedChatId(context, accountKey, chatId)
    },

    historyShapes: async (key, chatIds) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? new Map() : history.historyShapes(context, accountKey, chatIds)
    },

    recordHistorySkips: async (key, skips) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined || skips.size === 0) return
      write(database, () => history.recordHistorySkips(context, accountKey, skips))
    },

    setHistoryIncluded: async (key, chatId, included) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return false
      let done = false
      write(database, () => {
        done = history.setHistoryIncluded(context, accountKey, chatId, included)
      })
      return done
    },

    historySkips: async (key) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : history.historySkips(context, accountKey)
    },

    chatKind: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return undefined
      const row = context.database
        .prepare("SELECT kind FROM chats WHERE account_id = ? AND external_id = ?")
        .get(accountKey, chatId)
      return row ? (String(row.kind) as ChatKind) : undefined
    },

    chatTitle: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return null
      const row = context.database
        .prepare("SELECT title FROM chats WHERE account_id = ? AND external_id = ?")
        .get(accountKey, chatId)
      return row?.title == null ? null : String(row.title)
    },

    chatActivity: async (key, since, where) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined
        ? { chats: [], storedAt: null }
        : reads.chatActivity(context, accountKey, since, where)
    },

    chatMetadata: async (key, chatId) => chatQueries.metadata(context, key, chatId),
    saveChatMetadata: async (key, entry) => write(database, () => chatQueries.saveMetadata(context, key, entry)),
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
