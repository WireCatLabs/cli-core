import type { Id } from "../../domain/models.js"
import type { AccountKey, Range } from "./models.js"

export interface SyncStore {
  /** What a sync remembered under `name` for this account, and when; a caller encodes a number itself. */
  syncState(key: AccountKey, name: string): Promise<{ value: string; at: string } | undefined>

  setSyncState(key: AccountKey, name: string, value: string): Promise<void>

  clearSyncState(key: AccountKey, name: string): Promise<void>

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
}
