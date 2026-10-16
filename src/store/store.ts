import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { type AccountStore, type Area, bindAccount, type Keyed } from "./account-store.js"
import { type AccountAccounts, type AccountsStore, accountAccountsOver, accountsStoreOver } from "./accounts.js"
import {
  type AccountAttachments,
  type AttachmentsStore,
  accountAttachmentsOver,
  attachmentsStoreOver,
} from "./attachments.js"
import { type ChatsStore, chatsStoreOver } from "./chats.js"
import { type ConversationsStore, conversationsStoreOver } from "./conversations.js"
import { type AccountCounters, accountCountersOver, type CountersStore, countersStoreOver } from "./counters.js"
import { type AccountMentions, accountMentionsOver, type MentionsStore, mentionsStoreOver } from "./mentions.js"
import { type AccountMessages, accountMessagesOver, type MessagesStore, messagesStoreOver } from "./messages.js"
import { migrate } from "./migrations.js"
import { storeCapable } from "./open.js"
import { storePath } from "./path.js"
import { type AccountPeople, accountPeopleOver, type PeopleStore, peopleStoreOver } from "./people.js"
import { type QueriesStore, queriesStoreOver } from "./queries.js"
import { type RosterStore, rosterStoreOver } from "./roster.js"
import { type SearchIndexStore, searchIndexStoreOver } from "./search-index.js"
import { type SearchesStore, searchesStoreOver } from "./searches.js"
import { sharedConfigPath } from "./shared-config.js"
import * as accounts from "./sqlite/accounts.js"
import { type AgentActionsStore, agentActionsStoreOver } from "./sqlite/agent-actions.js"
import * as attachmentTexts from "./sqlite/attachment-texts.js"
import { backfillNormalized, pendingNormalization } from "./sqlite/backfill.js"
import { type BotUpdateStore, botUpdateStoreOver } from "./sqlite/bot-updates.js"
import { type CatalogStore, catalogStoreOver } from "./sqlite/catalog.js"
import { type MailStore, mailStoreOver } from "./sqlite/emails.js"
import { type FactsStore, factsStoreOver } from "./sqlite/facts.js"
import { fillFolded } from "./sqlite/folded.js"
import { type InvolvementStore, involvementStoreOver } from "./sqlite/involvements.js"
import { type KnowledgeStore, knowledgeStoreOver } from "./sqlite/knowledge.js"
import { logPruner } from "./sqlite/log-pruning.js"
import { type MeetingVectors, meetingVectorsOver } from "./sqlite/meeting-vectors.js"
import { meetingStoreOver, type StoredMeetings } from "./sqlite/meetings.js"
import { type MemoriesStore, memoriesStoreOver } from "./sqlite/memories.js"
import { type SourceMentionStore, sourceMentionStoreOver } from "./sqlite/mention-sources.js"
import { noteSearchOver } from "./sqlite/note-search.js"
import { type NotesStore, notesStoreOver } from "./sqlite/notes.js"
import { openSqlite, type StoreContext } from "./sqlite/open.js"
import { type ProposedActionsStore, proposedActionsStoreOver } from "./sqlite/proposed-actions.js"
import * as stems from "./sqlite/stems.js"
import { fillStems, followDefaultStemmers } from "./sqlite/stems-fill.js"
import { type StoreTaskStore, taskStoreOver } from "./sqlite/tasks.js"
import { type SyncStore, syncStoreOver } from "./sync.js"
import { type TagsStore, tagsStoreOver } from "./tags.js"
import type { AccountKey } from "./types.js"
import { type AccountVectors, accountVectorsOver, type VectorsStore, vectorsStoreOver } from "./vectors.js"

export interface MessageStore {
  /** Accounts, account groups and which account each app profile is. */
  readonly accounts: AccountsStore
  /** One account's chats: the list, what left, what is complete, their metadata. */
  readonly chats: ChatsStore
  /** Sync markers, catch-up deltas, stretch leases and the stretches held completely. */
  readonly sync: SyncStore
  /** Messages: writes, reads, tombstones, reactions, transcripts and the plain text search. */
  readonly messages: MessagesStore
  /** Downloaded files and the text held of them. */
  readonly attachments: AttachmentsStore
  /** Who is in a chat, and its member history. */
  readonly roster: RosterStore
  /** People and contacts, the links between their identities, and the owner's private notes on them. */
  readonly people: PeopleStore
  /** Reply links, conversation builds and the user's agent's batches. */
  readonly conversations: ConversationsStore
  /** Chunk, image and picture vectors, and the nearest conversations by meaning. */
  readonly vectors: VectorsStore
  /** View, forward and reaction counters as they were observed. */
  readonly counters: CountersStore
  /** The search history and saved searches. */
  readonly searches: SearchesStore
  /** A resolved Lucene query run over the store. */
  readonly queries: QueriesStore
  /** The word index, the stems and the stemmer choices. */
  readonly searchIndex: SearchIndexStore
  /** Tags on chats, people and messages. */
  readonly tags: TagsStore
  /** Phones, addresses, links and documents found in messages, and the owner's decisions on them. */
  readonly mentions: MentionsStore
  /** Open tasks waiting on the owner, for the task service in `src/tasks/`. */
  readonly botUpdates: BotUpdateStore
  readonly involvements: InvolvementStore
  readonly tasks: StoreTaskStore
  /** Mentions in documents, notes and mail: memo lists and decides them. */
  readonly sourceMentions: SourceMentionStore
  readonly knowledge: KnowledgeStore
  /** Notes, the links between anything and anything, and the owner's organisations and projects. */
  readonly notes: NotesStore
  readonly catalog: CatalogStore
  /** Choices that hold until replaced, each with its evidence. */
  readonly facts: FactsStore
  /** What agents concluded: summaries, digests, facts, preferences, each with evidence and a scope. */
  readonly memories: MemoriesStore
  /** What an agent wants done outside the store, waiting for the owner's approval. */
  readonly proposedActions: ProposedActionsStore
  /** One row per tool an agent called, never its arguments. */
  readonly agentActions: AgentActionsStore
  /** Meetings and calendar events: the port `src/meetings/` defines. */
  readonly meetingVectors: MeetingVectors
  readonly meetings: StoredMeetings
  /** Email threads, emails, recipients and mailboxes. */
  readonly mail: MailStore
  /** The same store with this account bound — what a service of one account reads and writes through. */
  forAccount(key: AccountKey): AccountStore
  close(): Promise<void>
}

export interface StoreOptions {
  path?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** The CLI's own name, for the advice a failed migration gives. */
  command?: string
}

/** About 40 ms of the first open (129k rows/s measured at 1M, 2026-09-30); Tab opens the store too. */
export const BACKFILL_ON_OPEN = 5_000

export const openStore = async ({ path, env, now = Date.now, command }: StoreOptions = {}): Promise<MessageStore> => {
  await storeCapable()
  const file = path ?? storePath(env)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  // Created before SQLite opens it: SQLite gives -wal and -shm the mode of the database file.
  writeFileSync(file, "", { flag: "a", mode: 0o600 })
  const { database, orm } = await openSqlite(file)
  try {
    migrate(database, { now, command })
    fillFolded(database)
    // A small file is filled on the spot; a larger one waits for `db migrate`, since nothing reads the copy yet.
    const pending = pendingNormalization(database)
    if (pending > 0 && pending <= BACKFILL_ON_OPEN) backfillNormalized(database)
    followDefaultStemmers(database, now)
    const stemming = stems.stemsState(database)
    if (
      stemming?.cause === "building" &&
      stemming.watermark - stemming.filledThrough + stemming.pending <= BACKFILL_ON_OPEN
    ) {
      fillStems(database, { now })
    }
    logPruner(database, now)()
  } catch (error) {
    database.close()
    throw error
  }
  return storeOver({ database, orm, now, sharedConfig: sharedConfigPath(file, env ?? process.env) })
}

/** Built on first use, once, so a spy on an area sees every call. */
const once = <T>(build: () => T): (() => T) => {
  let built: T | undefined
  return () => {
    built ??= build()
    return built
  }
}

const areaOf = <K extends Keyed<K>, A extends K>(keyed: () => K, whole: (keyed: K) => A): (() => Area<K, A>) =>
  once(() => {
    const part = keyed()
    return { keyed: part, whole: whole(part) }
  })

const storeOver = (context: StoreContext): MessageStore => {
  const { database } = context
  const stemmerFor = stems.stemmerCache()
  const pruneLogsWhenDue = logPruner(database, context.now)
  const own = <K extends Keyed<K>>(keyed: K): K => ({ ...keyed })

  // Built on first use: an area that prepares its statements must not stop the store opening for the rest.
  const mail = once(() => mailStoreOver(context, stemmerFor))
  const areas = {
    accounts: areaOf(
      () => accountAccountsOver(context),
      (keyed: AccountAccounts) => accountsStoreOver(context, keyed),
    ),
    chats: areaOf((): ChatsStore => chatsStoreOver(context), own),
    sync: areaOf((): SyncStore => syncStoreOver(context), own),
    messages: areaOf(
      () => accountMessagesOver(context),
      (keyed: AccountMessages) => messagesStoreOver(context, keyed),
    ),
    attachments: areaOf(
      () => accountAttachmentsOver(context),
      (keyed: AccountAttachments) => attachmentsStoreOver(context, keyed),
    ),
    roster: areaOf((): RosterStore => rosterStoreOver(context), own),
    people: areaOf(
      () => accountPeopleOver(context),
      (keyed: AccountPeople) => peopleStoreOver(context, keyed),
    ),
    conversations: areaOf((): ConversationsStore => conversationsStoreOver(context), own),
    vectors: areaOf(
      () => accountVectorsOver(context, mail),
      (keyed: AccountVectors) => vectorsStoreOver(context, keyed),
    ),
    counters: areaOf(
      () => accountCountersOver(context),
      (keyed: AccountCounters) => countersStoreOver(context, keyed),
    ),
    tags: areaOf((): TagsStore => tagsStoreOver(context), own),
    mentions: areaOf(
      () => accountMentionsOver(context),
      (keyed: AccountMentions) => mentionsStoreOver(context, keyed),
    ),
  }
  const searches = once(() => searchesStoreOver(context))
  const queries = once(() => queriesStoreOver(context, stemmerFor))
  const searchIndex = once(() => searchIndexStoreOver(context))
  const botUpdates = once(() => botUpdateStoreOver(context, pruneLogsWhenDue))
  const involvements = once(() => involvementStoreOver(context))
  const tasks = once(() => taskStoreOver(context))
  const sourceMentions = once(() => sourceMentionStoreOver(context))
  const knowledge = once(() => knowledgeStoreOver(context))
  const notes = once(() => ({ ...notesStoreOver(context), ...noteSearchOver(context) }))
  const catalog = once(() => catalogStoreOver(context))
  const facts = once(() => factsStoreOver(context))
  const memories = once(() => memoriesStoreOver(context))
  const proposedActions = once(() => proposedActionsStoreOver(context))
  const agentActions = once(() => agentActionsStoreOver(context, pruneLogsWhenDue))
  const meetings = once(() => meetingStoreOver(context))

  const store: MessageStore = {
    meetingVectors: meetingVectorsOver(context),
    get accounts() {
      return areas.accounts().whole
    },
    get chats() {
      return areas.chats().whole
    },
    get sync() {
      return areas.sync().whole
    },
    get messages() {
      return areas.messages().whole
    },
    get attachments() {
      return areas.attachments().whole
    },
    get roster() {
      return areas.roster().whole
    },
    get people() {
      return areas.people().whole
    },
    get conversations() {
      return areas.conversations().whole
    },
    get vectors() {
      return areas.vectors().whole
    },
    get counters() {
      return areas.counters().whole
    },
    get tags() {
      return areas.tags().whole
    },
    get mentions() {
      return areas.mentions().whole
    },
    get searches() {
      return searches()
    },
    get queries() {
      return queries()
    },
    get searchIndex() {
      return searchIndex()
    },
    get botUpdates() {
      return botUpdates()
    },
    get involvements() {
      return involvements()
    },
    get tasks() {
      return tasks()
    },
    get sourceMentions() {
      return sourceMentions()
    },
    get knowledge() {
      return knowledge()
    },
    get notes() {
      return notes()
    },
    get catalog() {
      return catalog()
    },
    get facts() {
      return facts()
    },
    get memories() {
      return memories()
    },
    get proposedActions() {
      return proposedActions()
    },
    get agentActions() {
      return agentActions()
    },
    get meetings() {
      return meetings()
    },
    get mail() {
      return mail()
    },

    forAccount: (key) =>
      bindAccount(store, key, areas, {
        accountPk: () => accounts.findAccountPk(context, key),
        attachmentAccount: (attachmentPk) => attachmentTexts.accountOf(context, attachmentPk),
      }),
    close: async () => database.close(),
  }
  return store
}

export type { CounterField, CounterObservations, CounterState } from "../domain/counters.js"
export type { RetentionOptions } from "../domain/retention.js"
export type { AccountAccounts, AccountsStore } from "./accounts.js"
export type { AccountAttachments, AttachmentsStore } from "./attachments.js"
export type { ChatsStore } from "./chats.js"
export type { ConversationsStore } from "./conversations.js"
export type { AccountCounters, CountersStore } from "./counters.js"
export type { AccountMentions, MentionsStore } from "./mentions.js"
export type { AccountMessages, MessagesStore } from "./messages.js"
export type { AccountPeople, PeopleStore } from "./people.js"
export type { QueriesStore } from "./queries.js"
export type { RosterStore } from "./roster.js"
export type { SearchIndexStore } from "./search-index.js"
export type { SearchesStore } from "./searches.js"
export { accountGroupsOf } from "./sqlite/account-groups.js"
export type { AdminStoreRequest, AdminStoreResult } from "./sqlite/admin-statistics.js"
export {
  type AttachmentTextEntry,
  type AttachmentView,
  attachmentColumns,
  type FileAttachment,
  resetAttachmentWords,
  type TextOrigin,
} from "./sqlite/attachment-texts.js"
export { pendingNormalization } from "./sqlite/backfill.js"
export { CHAT_COLUMNS, titlePart } from "./sqlite/chats.js"
export { CHAT_LIST_KEY, type ChatCompleteness, fetchedKey, historyStartKey } from "./sqlite/completeness.js"
export { CONVERSATION_COLUMNS } from "./sqlite/conversations.js"
export type { CounterTarget } from "./sqlite/counters.js"
export { messageOfEmail, threadConversation } from "./sqlite/emails.js"
export { orphanPointers } from "./sqlite/entity-types.js"
export { involvementStoreOver } from "./sqlite/involvements.js"
export type {
  MeetingContextReadCapabilities,
  MeetingReadCapabilities,
  TranscriptContextInput,
  TranscriptContextPage,
} from "./sqlite/meeting-reads.js"
export type { MeetingVectors } from "./sqlite/meeting-vectors.js"
export { OTHER_SOURCES, type OtherSource, type SourceMention } from "./sqlite/mention-sources.js"
export {
  MENTION_QUERY,
  MENTION_STATUSES,
  type MentionDecision,
  type MentionStatus,
  type MentionsRebuild,
  type MentionsState,
  type StoredMention,
} from "./sqlite/mentions.js"
export { drainNoteIndex, noteIndexState, resetNoteIndex } from "./sqlite/note-index.js"
export type { Link as ThingLink } from "./sqlite/notes.js"
export { savedPhoneCountries, saveStorePhoneCountries } from "./sqlite/phone-countries.js"
export type { PrivateContact, PrivateContactNote } from "./sqlite/private-people.js"
export type { ProposedAction } from "./sqlite/proposed-actions.js"
export { type ColumnMap, queryFilter, type Where } from "./sqlite/query-filter.js"
export type { RankedEvidence, RankingEvidenceItem, RankingEvidenceRequest } from "./sqlite/ranking-evidence.js"
export type { RankedStoreFound, RankedStoreRow, RankingRequest } from "./sqlite/rankings.js"
export { AGENDA_COLUMNS } from "./sqlite/reads.js"
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
  type StemsState,
  savedStemmers,
  stemmerCache,
  stemmersOrigin,
  stemsState,
} from "./sqlite/stems.js"
export { fillStems, resetStems } from "./sqlite/stems-fill.js"
export type { StoredTag, TagFilter, TagTarget, TaskTagTarget } from "./sqlite/tags.js"
export { savedTaskCategories } from "./sqlite/task-category-settings.js"
export { DEFAULT_AGENT_CLOSE, savedAgentClose } from "./sqlite/task-close.js"
export { inboxKey } from "./sqlite/tasks.js"
export type { MatchPlace, ScoredHit } from "./sqlite/words.js"
export type { TaskDetails } from "./sqlite/work-tasks.js"
export type { SyncStore } from "./sync.js"
export type { TagsStore } from "./tags.js"
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
  PictureInput,
  Range,
  SenderChatStats,
  StoredAccount,
  StoredChatFilter,
  StoredHit,
  StoredLink,
  StoredReadiness,
} from "./types.js"
export type { AccountVectors, VectorsStore } from "./vectors.js"
