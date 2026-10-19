import type { Id } from "../domain/models.js"
import { keysOver } from "./keys.js"
import * as chatQueries from "./sqlite/chats.js"
import type { StoreContext } from "./sqlite/open.js"
import * as ranges from "./sqlite/ranges.js"
import * as sync from "./sqlite/sync.js"
import { setTaskRulesStop, taskRulesStop } from "./sqlite/task-rule-stops.js"
import { write } from "./sqlite/transaction.js"
import type { AccountKey, Delta, Range } from "./types.js"

export interface SyncStore {
  /** What a sync remembered under `name` for this account, and when; a caller encodes a number itself. */
  syncState(key: AccountKey, name: string): Promise<{ value: string; at: string } | undefined>
  setSyncState(key: AccountKey, name: string, value: string): Promise<void>
  clearSyncState(key: AccountKey, name: string): Promise<void>
  /**
   * A catch-up's whole answer in one transaction, so a reader never sees half of it: chats, people,
   * each listed chat's members (replaced whole) and sync state such as a delta marker.
   */
  applyDelta(key: AccountKey, delta: Delta): Promise<void>
  /**
   * Takes the stretch of a chat at `anchor` for `forMs`; answers whether `holder` has it. Refused
   * while another holder's lease runs; the same holder renews its own.
   */
  claim(key: AccountKey, chatId: Id, anchor: string, holder: string, forMs: number): Promise<boolean>
  /** Gives the stretch back, if `holder` still has it. */
  release(key: AccountKey, chatId: Id, anchor: string, holder: string): Promise<void>
  /**
   * Records that every message from `from` to `to` (inclusive, by ordering key) is held, merging it
   * with the stretches it overlaps or touches. Answers the merged stretch.
   */
  markRange(key: AccountKey, chatId: Id, from: number, to: number): Promise<Range>
  /** The stretches held completely, oldest first. */
  ranges(key: AccountKey, chatId: Id): Promise<Range[]>
  /** Where the account's last task-rule pass stopped: the newest store time it read. */
  taskRulesStop(key: AccountKey): Promise<string | null>
  setTaskRulesStop(key: AccountKey, until: string): Promise<void>
}

export const syncStoreOver = (context: StoreContext): SyncStore => {
  const { database } = context
  const { accountPk, findAccountPk, chatKeyOf, chatPkFor, identityPk, writeMembers, writeState } = keysOver(context)
  return {
    syncState: async (key, name) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? undefined : sync.syncStateOf(context, accountKey, name)
    },

    setSyncState: async (key, name, value) => write(database, () => writeState(accountPk(key), name, value)),

    clearSyncState: async (key, name) => {
      const accountKey = findAccountPk(key)
      if (accountKey !== undefined) sync.clearState(context, accountKey, name)
    },

    applyDelta: async (key, { chats = [], people = [], members = new Map(), state = {} }) =>
      write(database, () => {
        const accountKey = accountPk(key)
        chatQueries.revisedBy(context, "delta", () => {
          for (const chat of chats) chatQueries.upsertChat(context, accountKey, chat)
        })
        for (const person of people) identityPk(accountKey, key.provider, person.id, person.name, person)
        for (const [chatId, ids] of members) writeMembers(key, accountKey, chatId, ids)
        for (const [name, value] of Object.entries(state)) writeState(accountKey, name, value)
      }),

    claim: async (key, chatId, anchor, holder, forMs) => {
      let taken = false
      write(database, () => {
        taken = sync.claim(context, chatPkFor(accountPk(key), chatId), anchor, holder, forMs)
      })
      return taken
    },

    release: async (key, chatId, anchor, holder) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey !== undefined) sync.release(context, chatKey, anchor, holder)
    },

    markRange: async (key, chatId, from, to) => {
      let merged: Range = { from, to }
      write(database, () => {
        merged = ranges.markRange(context, chatPkFor(accountPk(key), chatId), from, to)
      })
      return merged
    },

    ranges: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : ranges.ranges(context, chatKey)
    },

    taskRulesStop: async (key) => taskRulesStop(database, key),
    setTaskRulesStop: async (key, until) => setTaskRulesStop(database, key, until, context.now()),
  }
}
