import type { ContextEvidenceReader, ContextIndex, ContextRecordReader } from "../context/evidence.js"
import type { EventStore } from "../meetings/index.js"
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
import type { EvidenceFindingsStore } from "./evidence-findings.js"
import type { MeetingFindingsStore } from "./meeting-findings.js"
import { type AccountMentions, accountMentionsOver, type MentionsStore, mentionsStoreOver } from "./mentions.js"
import { type AccountMessages, accountMessagesOver, type MessagesStore, messagesStoreOver } from "./messages.js"
import { type AccountPeople, accountPeopleOver, type PeopleStore, peopleStoreOver } from "./people.js"
import type { ProjectAnnotationStore } from "./project-transfer/store.js"
import { type QueriesStore, queriesStoreOver } from "./queries.js"
import { type RosterStore, rosterStoreOver } from "./roster.js"
import { type SearchIndexStore, searchIndexStoreOver } from "./search-index.js"
import { type SearchesStore, searchesStoreOver } from "./searches.js"
import * as accounts from "./sqlite/accounts.js"
import { type AgentActionsStore, agentActionsStoreOver } from "./sqlite/agent-actions.js"
import * as attachmentTexts from "./sqlite/attachment-texts.js"
import { type BotUpdateStore, botUpdateStoreOver } from "./sqlite/bot-updates.js"
import { eventStoreOver } from "./sqlite/calendar.js"
import { type CatalogStore, catalogStoreOver } from "./sqlite/catalog.js"
import { contextEvidenceOver, contextIndexOver, contextRecordsOver } from "./sqlite/context-evidence.js"
import { type MailStore, mailStoreOver } from "./sqlite/emails.js"
import { type EventSearch, eventSearchOver } from "./sqlite/event-search.js"
import { evidenceFindingsStoreOver } from "./sqlite/evidence-findings.js"
import { type FactsStore, factsStoreOver } from "./sqlite/facts.js"
import { type FilesStore, filesStoreOver } from "./sqlite/files.js"
import { type InvolvementStore, involvementStoreOver } from "./sqlite/involvements.js"
import { type KnowledgeStore, knowledgeStoreOver } from "./sqlite/knowledge.js"
import { logPruner } from "./sqlite/log-pruning.js"
import { meetingFindingsStoreOver } from "./sqlite/meeting-findings.js"
import { type MeetingVectors, meetingVectorsOver } from "./sqlite/meeting-vectors.js"
import { meetingStoreOver, type StoredMeetings } from "./sqlite/meetings.js"
import { type MemoriesStore, memoriesStoreOver } from "./sqlite/memories.js"
import { type SourceMentionStore, sourceMentionStoreOver } from "./sqlite/mention-sources.js"
import { noteSearchOver } from "./sqlite/note-search.js"
import { type NotesStore, notesStoreOver } from "./sqlite/notes.js"
import type { StoreContext } from "./sqlite/open.js"
import { openStoreContext, type StoreOptions } from "./sqlite/open-store.js"
import { projectAnnotationStoreOver } from "./sqlite/project-transfer/store.js"
import { type ProposedActionsStore, proposedActionsStoreOver } from "./sqlite/proposed-actions.js"
import * as stems from "./sqlite/stems.js"
import { type StoreTaskStore, taskStoreOver } from "./sqlite/tasks.js"
import { type SyncStore, syncStoreOver } from "./sync.js"
import { type TagsStore, tagsStoreOver } from "./tags.js"
import type { AccountKey } from "./types.js"
import { type AccountVectors, accountVectorsOver, type VectorsStore, vectorsStoreOver } from "./vectors.js"

export interface MessageStore {
  readonly projectAnnotations?: ProjectAnnotationStore
  readonly contextEvidence?: ContextEvidenceReader
  readonly contextIndex?: ContextIndex
  readonly contextRecords?: ContextRecordReader
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
  /** Where each document is kept: its files, their folders and paths. */
  readonly files: FilesStore
  /** Calendars and their entries, the source records of events: the `EventStore` a calendar CLI writes through. */
  readonly calendar: EventStore & EventSearch
  /** Choices that hold until replaced, each with its evidence. */
  readonly meetingFindings: MeetingFindingsStore
  /** Cited facts and follow-ups about one project from stored messages, mail and documents, for review. */
  readonly evidenceFindings: EvidenceFindingsStore
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

export type { ChatHistoryShape, StoredHistorySkip } from "./sqlite/history-skips.js"
export { BACKFILL_ON_OPEN, type StoreOptions } from "./sqlite/open-store.js"
export { fileFacts, readStoreTables, type TableKind } from "./sqlite/store-tables.js"

export const openStore = async (options: StoreOptions = {}): Promise<MessageStore> => {
  const context = await openStoreContext(options)
  try {
    return storeOver(context)
  } catch (error) {
    context.database.close()
    throw error
  }
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
  const contextEvidence = once(() => contextEvidenceOver(context))
  const projectAnnotations = once(() => projectAnnotationStoreOver(context))
  const contextIndex = once(() => contextIndexOver(context, stemmerFor))
  const contextRecords = once(() => contextRecordsOver(context))
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
  const files = once(() => filesStoreOver(context))
  const calendar = once(() => ({ ...eventStoreOver(context), ...eventSearchOver(context) }))
  const meetingFindings = once(() => meetingFindingsStoreOver(context))
  const evidenceFindings = once(() => evidenceFindingsStoreOver(context))
  const facts = once(() => factsStoreOver(context))
  const memories = once(() => memoriesStoreOver(context))
  const proposedActions = once(() => proposedActionsStoreOver(context))
  const agentActions = once(() => agentActionsStoreOver(context, pruneLogsWhenDue))
  const meetings = once(() => meetingStoreOver(context))

  const store: MessageStore = {
    get projectAnnotations() {
      return projectAnnotations()
    },
    get contextEvidence() {
      return contextEvidence()
    },
    get contextIndex() {
      return contextIndex()
    },
    get contextRecords() {
      return contextRecords()
    },
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
    get files() {
      return files()
    },
    get calendar() {
      return calendar()
    },
    get meetingFindings() {
      return meetingFindings()
    },
    get evidenceFindings() {
      return evidenceFindings()
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

export * from "./exports.js"
