import type { AccountKey } from "../store.js"

export interface BotUpdate {
  id: number
  externalId: string
  kind: string
  /** `null` once the update was handled more than 30 days ago (`LOG_RETENTION`). */
  payload: unknown
  receivedAt: number
  handledAt: number | null
  error: string | null
  replayedAt: number | null
}

export interface BotUpdateStore {
  save(
    account: AccountKey,
    update: { externalId: string; kind: string; payload: unknown; receivedAt?: number },
  ): boolean
  handled(account: AccountKey, externalId: string): void
  failed(account: AccountKey, externalId: string, error: string): void
  replayed(account: AccountKey, externalId: string): void
  /** Which of these were handled already: a redelivery to skip. A failed one is not among them. */
  handledOf(account: AccountKey, externalIds: readonly string[]): Set<string>
  recent(account: AccountKey, limit?: number): BotUpdate[]
}
