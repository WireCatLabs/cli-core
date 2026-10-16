import type { CounterObservations, CounterState } from "../domain/counters.js"
import type { Id } from "../domain/models.js"
import type { QueryExecution } from "../search/lucene/resolved.js"
import { applyCounterObservations, type CounterTarget, counterStates, counterTargets } from "./sqlite/counters.js"
import type { StoreContext } from "./sqlite/open.js"
import { write } from "./sqlite/transaction.js"
import type { AccountKey } from "./types.js"

export interface AccountCounters {
  counterStates(
    key: AccountKey,
    chatId: Id,
    messageId: Id,
    options: { now: number; maxAge: number },
  ): Promise<CounterState[]>
  updateCounterObservations(
    key: AccountKey,
    chatId: Id,
    messageId: Id,
    observations: CounterObservations,
  ): Promise<number>
}

export interface CountersStore extends AccountCounters {
  counterTargets(
    execution: QueryExecution,
    options: { now: number; maxAge: number },
  ): Promise<{ items: CounterTarget[]; hasMore: boolean }>
}

const LIVE_MESSAGE =
  "SELECT m.id AS pk FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id WHERE ac.provider=? AND ac.external_id=? AND c.external_id=? AND m.external_id=? AND m.deleted_at IS NULL"

export const accountCountersOver = (context: StoreContext): AccountCounters => {
  const { database } = context
  return {
    counterStates: async (key, chatId, messageId, options) => {
      const row = database.prepare(LIVE_MESSAGE).get(key.provider, key.account, chatId, messageId)
      return row ? counterStates(context, Number(row.pk), options.now, options.maxAge) : []
    },
    updateCounterObservations: async (key, chatId, messageId, observations) => {
      let updated = 0
      write(database, () => {
        const row = database.prepare(LIVE_MESSAGE).get(key.provider, key.account, chatId, messageId)
        if (row) updated = applyCounterObservations(context, Number(row.pk), observations)
      })
      return updated
    },
  }
}

export const countersStoreOver = (context: StoreContext, keyed: AccountCounters): CountersStore => ({
  ...keyed,
  counterTargets: async (execution, options) => counterTargets(context, execution, options),
})
