import type { CounterState } from "../../domain/counters.js"

export interface CounterTarget {
  locator: string
  account: { provider: string; account: string }
  chatId: string
  messageId: string
  counters: CounterState[]
}
