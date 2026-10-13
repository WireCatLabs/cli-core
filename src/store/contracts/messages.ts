import type { CounterObservations, CounterState } from "../../domain/counters.js"
import type { Id, Message, Page, Reactions, WindowedMessage } from "../../domain/models.js"
import type { QueryExecution } from "../../search/lucene/resolved.js"
import type { CounterTarget } from "./counters-types.js"
import type { DocumentLinkMessage } from "./document-links-types.js"
import type { AccountKey, DeletionScope, Delta, IngestedVia, StoredHit } from "./models.js"

export interface MessagesStore {
  /** A scheduled message is not kept: it is not history yet. */
  /**
   * `seenAt` is when the messenger was asked: a message it still returned is not deleted, so a
   * tombstone older than that is lifted. A tombstone set after it stays — the deletion is newer.
   */
  saveMessages(
    key: AccountKey,
    chatId: Id,
    messages: Message[],
    options: { via: IngestedVia; seenAt?: number },
  ): Promise<void>

  /**
   * A catch-up's whole answer in one transaction, so a reader never sees half of it: chats, people,
   * each listed chat's members (replaced whole) and sync state such as a delta marker.
   */
  applyDelta(key: AccountKey, delta: Delta): Promise<void>

  /** Oldest to newest, like a provider's history page. */
  /** `threadId` keeps one forum topic's; `outgoing` only the owner's (true) or only the others' (false). */
  messages(
    key: AccountKey,
    chatId: Id,
    window: { limit: number; before?: Id; since?: string; threadId?: Id; outgoing?: boolean },
  ): Promise<Page<Message>>

  /** How many stored messages the chat has, sent at `since` or later when it is given. */
  countMessages(key: AccountKey, chatId: Id, options?: { since?: string }): Promise<number>

  /** The chat's messages that may hold a Google document link, newest first, with the documents linked from each. */
  documentLinkMessages(key: AccountKey, chatId: Id): Promise<DocumentLinkMessage[]>

  /** Saved or edited after `at` (ISO, this machine's clock), oldest first, and the ids deleted after it. */
  changes(key: AccountKey, chatId: Id, at: string): Promise<{ messages: Message[]; deleted: Id[] }>

  /**
   * By time rather than by id: `before` messages sent at `at` or earlier and `after` sent later,
   * oldest first. `around` answers the same question for a message id.
   */
  messagesWindow(key: AccountKey, chatId: Id, window: { at: string; before: number; after: number }): Promise<Message[]>

  /**
   * A stored message and its stored neighbours, oldest first, the one asked for with `anchor`. Until
   * backfill records which stretches are complete, a neighbour here is the nearest one kept, not
   * necessarily the next one sent.
   */
  around(
    key: AccountKey,
    chatId: Id,
    messageId: Id,
    window: { before: number; after: number },
  ): Promise<WindowedMessage[]>

  /**
   * One message by its id. Without `chatId` it is looked up across the account, which is enough
   * where ids are unique per account (MAX) and refused where two chats share one (Telegram).
   */
  message(key: AccountKey, messageId: Id, options?: { chatId?: Id }): Promise<Message | undefined>

  /**
   * Everything one account holds — its chats, messages, members, state, leases, transcripts and whom
   * it has seen — for `cache clear`. Other accounts, and identities they share, stay.
   */
  purge(key: AccountKey): Promise<void>

  /**
   * A tombstone, not a removal: the row stays, so a copy fetched before the deletion does not bring
   * the message back, and reads and search stop returning it. Its text goes — from the row, the
   * search copy, the edit history and the transcript. Only the messenger returning it again, when
   * asked after the deletion, lifts the tombstone (`saveMessages`' `seenAt`).
   *
   * Without `chatId`, a message is tombstoned only when exactly one live message with its id is left
   * in the chats `among` accepts. Without `among`, nothing is: only the messenger knows which of its
   * chats a deletion without one may belong to (`Messenger.deletedWithoutChat`).
   */
  markDeleted(key: AccountKey, messageIds: Id[], options?: { chatId?: Id; among?: DeletionScope }): Promise<number>

  directReplies?(parents: { account: AccountKey; chatId: Id; id: Id }[], limit: number): Promise<Page<StoredHit>>

  /** A message's reactions as they are now; answers whether the message is held at all. */
  saveReactions(
    key: AccountKey,
    chatId: Id,
    messageId: Id,
    reactions: Reactions,
    options?: { observation?: CounterObservations["reactions"] },
  ): Promise<boolean>

  counterTargets?(
    execution: QueryExecution,
    options: { now: number; maxAge: number },
  ): Promise<{ items: CounterTarget[]; hasMore: boolean }>

  counterStates?(
    key: AccountKey,
    chatId: Id,
    messageId: Id,
    options: { now: number; maxAge: number },
  ): Promise<CounterState[]>

  updateCounterObservations?(
    key: AccountKey,
    chatId: Id,
    messageId: Id,
    observations: CounterObservations,
  ): Promise<number>
}
