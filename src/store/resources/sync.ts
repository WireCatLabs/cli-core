import type { Range } from "../contracts/models.js"
import type { SyncStore } from "../contracts/sync.js"
import * as ranges from "../sqlite/ranges.js"
import * as sync from "../sqlite/sync.js"
import type { StoreRuntime } from "./runtime.js"

export const syncStoreOver = ({
  context,
  inTransaction,
  accountPk,
  findAccountPk,
  findChatPk,
  chatPkFor,
  writeState,
}: Pick<
  StoreRuntime,
  "context" | "inTransaction" | "accountPk" | "findAccountPk" | "findChatPk" | "chatPkFor" | "writeState"
>): SyncStore => {
  return {
    syncState: async (key, name) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? undefined : sync.syncStateOf(context, accountKey, name)
    },

    setSyncState: async (key, name, value) => inTransaction(() => writeState(accountPk(key), name, value)),

    clearSyncState: async (key, name) => {
      const accountKey = findAccountPk(key)
      if (accountKey !== undefined) sync.clearState(context, accountKey, name)
    },

    claim: async (key, chatId, anchor, holder, forMs) => {
      let taken = false
      inTransaction(() => {
        taken = sync.claim(context, chatPkFor(accountPk(key), chatId), anchor, holder, forMs)
      })
      return taken
    },

    release: async (key, chatId, anchor, holder) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      if (chatKey !== undefined) sync.release(context, chatKey, anchor, holder)
    },

    markRange: async (key, chatId, from, to) => {
      let merged: Range = { from, to }
      inTransaction(() => {
        merged = ranges.markRange(context, chatPkFor(accountPk(key), chatId), from, to)
      })
      return merged
    },

    ranges: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      return chatKey === undefined ? [] : ranges.ranges(context, chatKey)
    },
  }
}
