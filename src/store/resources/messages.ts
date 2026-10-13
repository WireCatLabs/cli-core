import type { MessagesStore } from "../contracts/messages.js"
import * as accounts from "../sqlite/accounts.js"
import * as chatQueries from "../sqlite/chats.js"
import { applyCounterObservations, counterStates, counterTargets } from "../sqlite/counters.js"
import { documentLinkMessages } from "../sqlite/document-links.js"
import * as messageWrites from "../sqlite/messages.js"
import * as reads from "../sqlite/reads.js"
import * as search from "../sqlite/search.js"
import type { StoreRuntime } from "./runtime.js"

export const messagesStoreOver = ({
  context,
  database,
  inTransaction,
  accountPk,
  findAccountPk,
  findChatPk,
  chatKeyOf,
  chatPkFor,
  identityPk,
  upsertMessage,
  writeMembers,
  writeState,
}: Pick<
  StoreRuntime,
  | "context"
  | "database"
  | "inTransaction"
  | "accountPk"
  | "findAccountPk"
  | "findChatPk"
  | "chatKeyOf"
  | "chatPkFor"
  | "identityPk"
  | "upsertMessage"
  | "writeMembers"
  | "writeState"
>): MessagesStore => {
  return {
    saveMessages: async (key, chatId, messages, { via, seenAt }) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        const chatKey = chatPkFor(accountKey, chatId)
        for (const message of messages) {
          if (message.scheduledFor === undefined) upsertMessage(key, accountKey, chatKey, message, via, seenAt)
        }
      }),

    applyDelta: async (key, { chats = [], people = [], members = new Map(), state = {} }) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        for (const chat of chats) chatQueries.upsertChat(context, accountKey, chat)
        for (const person of people) identityPk(accountKey, key.provider, person.id, person.name, person)
        for (const [chatId, ids] of members) writeMembers(key, accountKey, chatId, ids)
        for (const [name, value] of Object.entries(state)) writeState(accountKey, name, value)
      }),

    countMessages: async (key, chatId, { since } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? 0 : reads.countMessages(context, chatKey, since)
    },

    documentLinkMessages: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : documentLinkMessages(context, chatKey)
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

    messages: async (key, chatId, window) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? { items: [], hasMore: false } : reads.messagePage(context, chatKey, window)
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
      inTransaction(() => {
        changed = messageWrites.markDeleted(context, accountKey, messageIds, chatId, among)
      })
      return changed
    },

    purge: async (key) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return
      inTransaction(() => accounts.purgeAccount(context, accountKey))
    },

    directReplies: async (parents, limit) => search.directReplies(context, parents, limit),

    counterTargets: async (execution, options) => counterTargets(context, execution, options),

    counterStates: async (key, chatId, messageId, options) => {
      const row = database
        .prepare(
          "SELECT m.id AS pk FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id WHERE ac.provider=? AND ac.external_id=? AND c.external_id=? AND m.external_id=? AND m.deleted_at IS NULL",
        )
        .get(key.provider, key.account, chatId, messageId)
      return row ? counterStates(context, Number(row.pk), options.now, options.maxAge) : []
    },

    updateCounterObservations: async (key, chatId, messageId, observations) => {
      let updated = 0
      inTransaction(() => {
        const row = database
          .prepare(
            "SELECT m.id AS pk FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id WHERE ac.provider=? AND ac.external_id=? AND c.external_id=? AND m.external_id=? AND m.deleted_at IS NULL",
          )
          .get(key.provider, key.account, chatId, messageId)
        if (row) updated = applyCounterObservations(context, Number(row.pk), observations)
      })
      return updated
    },

    saveReactions: async (key, chatId, messageId, reactions, options = {}) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      if (chatKey === undefined) return false
      let saved = false
      inTransaction(() => {
        saved = messageWrites.saveReactions(context, chatKey, messageId, reactions)
        const row = database
          .prepare("SELECT id AS pk FROM messages WHERE chat_id=? AND external_id=? AND deleted_at IS NULL")
          .get(chatKey, messageId)
        if (row && options.observation)
          applyCounterObservations(context, Number(row.pk), { reactions: options.observation })
      })
      return saved
    },
  }
}
