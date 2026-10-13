import type { AccountsStore } from "./contracts/accounts.js"
import type { AttachmentsStore } from "./contracts/attachments.js"
import type { ChatsStore } from "./contracts/chats.js"
import type { ConversationsStore } from "./contracts/conversations.js"
import type { MessagesStore } from "./contracts/messages.js"
import type { AccountKey, StoreOptions } from "./contracts/models.js"
import type { PeopleStore } from "./contracts/people.js"
import type { SearchStore } from "./contracts/search.js"
import type { SourcesStore } from "./contracts/sources.js"
import type { SyncStore } from "./contracts/sync.js"

export type {
  AccountKey,
  AccountMessageFilter,
  AgentAnswer,
  BatchMessage,
  ChatActivity,
  ChatStats,
  ConversationBuild,
  ConversationHit,
  ConversationSummary,
  DeletionScope,
  Delta,
  IdentityRef,
  IngestedVia,
  LinkBatch,
  LinkedIdentity,
  LinkOptions,
  MessageFilter,
  PersonFacts,
  PersonRecord,
  Range,
  SenderChatStats,
  StoredAccount,
  StoredChatFilter,
  StoredHit,
  StoredLink,
  StoredReadiness,
  StoreOptions,
} from "./contracts/models.js"

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { type AccountStore, bindAccount } from "./account-store.js"
import { migrate } from "./migrations.js"
import { removeOldStore } from "./old-store.js"
import { storeCapable } from "./open.js"
import { storePath } from "./path.js"
import { accountsStoreOver } from "./resources/accounts.js"
import { attachmentsStoreOver } from "./resources/attachments.js"
import { chatsStoreOver } from "./resources/chats.js"
import { conversationsStoreOver } from "./resources/conversations.js"
import { messagesStoreOver } from "./resources/messages.js"
import { peopleStoreOver } from "./resources/people.js"
import { storeRuntime } from "./resources/runtime.js"
import { searchStoreOver } from "./resources/search.js"
import { sourcesStoreOver } from "./resources/sources.js"
import { syncStoreOver } from "./resources/sync.js"
import * as attachmentTexts from "./sqlite/attachment-texts.js"
import { backfillNormalized, pendingNormalization } from "./sqlite/backfill.js"
import { logPruner } from "./sqlite/log-pruning.js"
import { openSqlite, type StoreContext } from "./sqlite/open.js"
import * as stems from "./sqlite/stems.js"
export interface MessageStore
  extends AccountsStore,
    ChatsStore,
    MessagesStore,
    SyncStore,
    AttachmentsStore,
    ConversationsStore,
    SearchStore,
    PeopleStore,
    SourcesStore {
  /** The same store with this account bound — what a service of one account reads and writes through. */
  forAccount(key: AccountKey): AccountStore

  close(): Promise<void>
}

/** About 40 ms of the first open (129k rows/s measured at 1M, 2026-09-30); Tab opens the store too. */
export const BACKFILL_ON_OPEN = 5_000

export const openStore = async ({ path, env, now = Date.now, command }: StoreOptions = {}): Promise<MessageStore> => {
  await storeCapable()
  const file = path ?? storePath(env)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  if (path === undefined && (env ?? process.env).MESSAGING_STORE === undefined) {
    const removed = await removeOldStore(dirname(file)).catch(() => undefined)
    if (removed) process.stderr.write(`Deleted the old message store ${removed}; everything now lives in ${file}.\n`)
  }
  // Created before SQLite opens it: SQLite gives -wal and -shm the mode of the database file.
  writeFileSync(file, "", { flag: "a", mode: 0o600 })
  const { database, orm } = await openSqlite(file)
  try {
    migrate(database, { now, command })
    // A small file is filled on the spot; a larger one waits for `db migrate`, since nothing reads the copy yet.
    const pending = pendingNormalization(database)
    if (pending > 0 && pending <= BACKFILL_ON_OPEN) backfillNormalized(database)
    stems.followDefaultStemmers(database, now)
    const stemming = stems.stemsState(database)
    if (
      stemming?.cause === "building" &&
      stemming.watermark - stemming.filledThrough + stemming.pending <= BACKFILL_ON_OPEN
    ) {
      stems.fillStems(database, { now })
    }
    logPruner(database, now)()
  } catch (error) {
    database.close()
    throw error
  }
  return storeOver({ database, orm, now })
}
const storeOver = (context: StoreContext): MessageStore => {
  const runtime = storeRuntime(context)
  const store = {} as MessageStore
  for (const resource of [
    accountsStoreOver(runtime),
    chatsStoreOver(runtime),
    messagesStoreOver(runtime),
    syncStoreOver(runtime),
    attachmentsStoreOver(runtime),
    conversationsStoreOver(runtime),
    searchStoreOver(runtime),
    peopleStoreOver(runtime),
    sourcesStoreOver(runtime),
  ]) {
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(resource))
  }
  store.forAccount = (key) =>
    bindAccount(store, key, {
      accountPk: () => runtime.findAccountPk(key),
      attachmentAccount: (attachmentPk) => attachmentTexts.accountOf(context, attachmentPk),
    })
  store.close = async () => context.database.close()
  return store
}

export type { CounterField, CounterObservations, CounterState } from "../domain/counters.js"
export type { RetentionOptions } from "../domain/retention.js"
export { accountGroupsOf } from "./sqlite/account-groups.js"
export type { AdminStoreRequest, AdminStoreResult } from "./sqlite/admin-statistics.js"
export {
  type AttachmentTextEntry,
  type AttachmentView,
  type FileAttachment,
  resetAttachmentWords,
  type TextOrigin,
} from "./sqlite/attachment-texts.js"
export { pendingNormalization } from "./sqlite/backfill.js"
export { CHAT_LIST_KEY, type ChatCompleteness, fetchedKey, historyStartKey } from "./sqlite/completeness.js"
export type { CounterTarget } from "./sqlite/counters.js"
export { messageOfEmail, threadConversation } from "./sqlite/emails.js"
export { orphanPointers } from "./sqlite/entity-types.js"
export { involvementStoreOver } from "./sqlite/involvements.js"
export type { MeetingReadCapabilities } from "./sqlite/meeting-reads.js"
export type { MeetingVectors } from "./sqlite/meeting-vectors.js"
export { drainNoteIndex, noteIndexState, resetNoteIndex } from "./sqlite/note-index.js"
export type { Link as ThingLink } from "./sqlite/notes.js"
export type { ProposedAction } from "./sqlite/proposed-actions.js"
export type { RankedEvidence, RankingEvidenceItem, RankingEvidenceRequest } from "./sqlite/ranking-evidence.js"
export type { RankedStoreFound, RankedStoreRow, RankingRequest } from "./sqlite/rankings.js"
export type { RetentionResult } from "./sqlite/retention.js"
export type {
  MemberCount,
  MemberStay,
  ProfileRevision,
  RosterChange,
  RosterRead,
  TrackedChat,
} from "./sqlite/roster.js"
export { fillSearchIndex, resetSearchIndex, searchIndexState } from "./sqlite/search-index.js"
export type { SearchCommand, SearchRecord, StoredSearch } from "./sqlite/searches.js"
export {
  fillStems,
  resetStems,
  type StemsState,
  savedStemmers,
  stemmerCache,
  stemmersOrigin,
  stemsState,
} from "./sqlite/stems.js"
export type { StoredTag, TagFilter, TagTarget } from "./sqlite/tags.js"
export { inboxKey } from "./sqlite/tasks.js"
export type { MatchPlace, ScoredHit, SearchScope, WordOptions, WordQuery } from "./sqlite/words.js"
export type { TaskDetails } from "./sqlite/work-tasks.js"
