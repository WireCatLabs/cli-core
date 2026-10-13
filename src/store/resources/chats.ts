import type { ChatsStore } from "../contracts/chats.js"
import * as accounts from "../sqlite/accounts.js"
import * as metadataQueries from "../sqlite/chats.js"
import * as chatQueries from "../sqlite/chats.js"
import * as completeness from "../sqlite/completeness.js"
import * as reads from "../sqlite/reads.js"
import type { RosterChange } from "../sqlite/roster.js"
import * as roster from "../sqlite/roster.js"
import type { StoreRuntime } from "./runtime.js"

export const chatsStoreOver = ({
  context,
  inTransaction,
  accountPk,
  findAccountPk,
  findChatPk,
  chatKeyOf,
  chatPkFor,
  writeMembers,
  writeState,
}: Pick<
  StoreRuntime,
  | "context"
  | "inTransaction"
  | "accountPk"
  | "findAccountPk"
  | "findChatPk"
  | "chatKeyOf"
  | "chatPkFor"
  | "writeMembers"
  | "writeState"
>): ChatsStore => {
  return {
    saveChats: async (key, list) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        for (const chat of list) chatQueries.upsertChat(context, accountKey, chat)
      }),

    saveMembers: async (key, chatId, memberIds) =>
      inTransaction(() => writeMembers(key, accountPk(key), chatId, memberIds)),

    saveRoster: async (key, chatId, read) => {
      let change: RosterChange = { joined: [], gone: [], changed: [] }
      inTransaction(() => {
        const accountKey = accountPk(key)
        change = roster.saveRoster(context, accountKey, key.provider, chatPkFor(accountKey, chatId), read)
      })
      return change
    },

    memberStays: async (key, chatId, { since } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? []
        : roster.memberStaysOf(context, chatKey, since === undefined ? undefined : Date.parse(since))
    },

    memberCounts: async (key, chatId, { since } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : roster.memberCountsOf(context, chatKey, since)
    },

    profileRevisions: async (key, chatId, { since } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? []
        : roster.profileRevisionsOf(context, chatKey, since === undefined ? undefined : Date.parse(since))
    },

    trackMembers: async (key, chatId, tracked) =>
      inTransaction(() => roster.setTracked(context, chatPkFor(accountPk(key), chatId), tracked)),

    trackedChats: async (key) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : roster.trackedChats(context, accountKey)
    },

    members: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      return chatKey === undefined ? [] : chatQueries.members(context, chatKey)
    },

    chatsWith: async (key, memberId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : chatQueries.chatsWith(context, accountKey, key, memberId)
    },

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

    markChatsLeft: async (key, present) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return 0
      let marked = 0
      inTransaction(() => {
        marked = chatQueries.markLeft(context, accountKey, present)
        writeState(accountKey, completeness.CHAT_LIST_KEY, String(present.length))
      })
      return marked
    },

    leftChats: async (key, { clear = false } = {}) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return { chats: 0, messages: 0 }
      let found = { pks: [] as number[], messages: 0 }
      inTransaction(() => {
        found = chatQueries.leftChats(context, accountKey)
        if (clear) chatQueries.purgeChats(context, found.pks)
      })
      return { chats: found.pks.length, messages: found.messages }
    },

    chatCompleteness: async (key, chatIds) => {
      const accountKey = accounts.findAccountPk(context, key)
      return accountKey === undefined ? [] : completeness.chatCompleteness(context, accountKey, chatIds)
    },

    chatStats: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : reads.chatStats(context, accountKey, chatId)
    },

    chatActivity: async (key, since) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? { chats: [], storedAt: null } : reads.chatActivity(context, accountKey, since)
    },

    chatMetadata: async (key, chatId) => metadataQueries.metadata(context, key, chatId),

    saveChatMetadata: async (key, entry) => metadataQueries.saveMetadata(context, key, entry),

    replaceAutoTags: async (key, chatId, algorithm, matches) =>
      inTransaction(() => metadataQueries.replaceAutoTags(context, key, chatId, algorithm, matches)),
  }
}
