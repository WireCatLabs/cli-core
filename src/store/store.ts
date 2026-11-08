import type { ContextEvidenceReader, ContextIndex, ContextRecordReader } from "../context/evidence.js"
import type { RefsStore } from "../domain/ref-summaries.js"
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
import { DEFAULT_DECISION_POLICY, type DecisionPolicy } from "./decisions.js"
import type { EvidenceFindingsStore } from "./evidence-findings.js"
import type { MailFindingsStore } from "./mail-findings.js"
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
import { addedSourcesOver } from "./sqlite/added-sources.js"
import { type AgentActionsStore, agentActionsStoreOver } from "./sqlite/agent-actions.js"
import * as attachmentTexts from "./sqlite/attachment-texts.js"
import { type BotUpdateStore, botUpdateStoreOver } from "./sqlite/bot-updates.js"
import { type ContractsStore, contractsStoreOver } from "./sqlite/business-contracts.js"
import { type BusinessSearchStore, businessSearchOver } from "./sqlite/business-search.js"
import { eventStoreOver } from "./sqlite/calendar.js"
import { type CatalogStore, catalogStoreOver } from "./sqlite/catalog.js"
import { contextEvidenceOver, contextIndexOver, contextRecordsOver } from "./sqlite/context-evidence.js"
import { type CrmCopies, crmCopiesOver } from "./sqlite/crm.js"
import { type DealsStore, dealsStoreOver } from "./sqlite/deals.js"
import { type DecisionRequestStore, decisionRequestStoreOver } from "./sqlite/decision-requests.js"
import { type MailStore, mailStoreOver } from "./sqlite/emails.js"
import { type EventSearch, eventSearchOver } from "./sqlite/event-search.js"
import { evidenceFindingsStoreOver } from "./sqlite/evidence-findings.js"
import { type FactsStore, factsStoreOver } from "./sqlite/facts.js"
import { type FilesStore, filesStoreOver } from "./sqlite/files.js"
import { type FinanceStore, financeStoreOver } from "./sqlite/finance.js"
import { type InvolvementStore, involvementStoreOver } from "./sqlite/involvements.js"
import { type KnowledgeStore, knowledgeStoreOver } from "./sqlite/knowledge.js"
import { logPruner } from "./sqlite/log-pruning.js"
import { mailFindingsStoreOver } from "./sqlite/mail-findings.js"
import { meetingFindingsStoreOver } from "./sqlite/meeting-findings.js"
import { type MeetingVectors, meetingVectorsOver } from "./sqlite/meeting-vectors.js"
import { meetingStoreOver, type StoredMeetings } from "./sqlite/meetings.js"
import { type MemoriesStore, memoriesStoreOver } from "./sqlite/memories.js"
import { type SourceMentionStore, sourceMentionStoreOver } from "./sqlite/mention-sources.js"
import { type TransactionsStore, transactionsStoreOver } from "./sqlite/money-transactions.js"
import { noteSearchOver } from "./sqlite/note-search.js"
import { type NotesStore, notesStoreOver } from "./sqlite/notes.js"
import type { StoreContext } from "./sqlite/open.js"
import { openStoreContext, type StoreOptions } from "./sqlite/open-store.js"
import { type OrdersStore, ordersStoreOver } from "./sqlite/orders.js"
import { type ProductsStore, productsStoreOver } from "./sqlite/products.js"
import { projectAnnotationStoreOver } from "./sqlite/project-transfer/store.js"
import { type ProposedActionsStore, proposedActionsStoreOver } from "./sqlite/proposed-actions.js"
import { type RecordStore, recordStoreOver } from "./sqlite/records.js"
import { refsStoreOver } from "./sqlite/ref-summaries.js"
import { type RelationsStore, relationsStoreOver } from "./sqlite/reported-relations.js"
import * as stems from "./sqlite/stems.js"
import { type SubscriptionsStore, subscriptionsStoreOver } from "./sqlite/subscriptions.js"
import { type StoreTaskStore, taskStoreOver } from "./sqlite/tasks.js"
import { type WalletsStore, walletsStoreOver } from "./sqlite/wallets.js"
import { storeErrors } from "./store-errors.js"
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
  /** What an agent read in new mail, cited and staged per mailbox; only the owner decides it. */
  readonly mailFindings: MailFindingsStore
  /** What any ref names, a page of them at a time: read once per page, never once per row. */
  readonly refs: RefsStore
  readonly facts: FactsStore
  /** Invoices, payments and their allocations, in exact minor units; an agent's or an import's wait for the owner. */
  readonly finance: FinanceStore
  /** What the owner, his business or a client ordered and how far delivery got; an agent's wait for the owner. */
  readonly orders: OrdersStore
  /** The owner's sales pipelines and the deals in them, written directly by the owner and his agents. */
  readonly deals: DealsStore
  /** What the owner or a supplier sells, with its price; written directly. */
  readonly products: ProductsStore
  /** The contracts the owner works under; one with a value from an agent or an import waits for the owner. */
  readonly contracts: ContractsStore
  /** Subscriptions the owner bills or pays, with a price history never overwritten. */
  readonly subscriptions: SubscriptionsStore
  /** Bank accounts, cards and cash, with balances computed from their transactions. */
  readonly wallets: WalletsStore
  /** What statements say moved on the wallets, split by category; an agent's or an import's wait for the owner. */
  readonly transactions: TransactionsStore
  /** Invoices, payments, orders, contracts, subscriptions, products and wallets, found by their numbers and names. */
  readonly business: BusinessSearchStore
  /** A CRM account's pipelines, deals, leads, contacts and companies, written as the CRM has them. */
  readonly crm: CrmCopies
  /** Relationships a source account reports, written as a diff that never overrides the owner's. */
  readonly relations: RelationsStore
  /** The one-time keys behind the buttons of a message that asks the owner to decide a batch. */
  readonly decisionRequests: DecisionRequestStore
  /** What each import said, by the source's identity; `ingest` (services) is the way in. */
  readonly records: RecordStore
  /** What agents concluded: summaries, digests, facts, preferences, each with evidence and a scope. */
  readonly memories: MemoriesStore
  /** What an agent wants done outside the store, waiting for the owner's approval. */
  readonly proposedActions: ProposedActionsStore
  /** Who may decide proposals, fixed when the store was opened; the store's decide methods and the registry read it. */
  readonly decisionPolicy: DecisionPolicy
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
export type { ChatScope, NewestMessage, ReplyDelay, WaitingChat } from "./sqlite/reply-times.js"
export { rollBack } from "./sqlite/rollback-copy.js"
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
  return () => (built ??= storeErrors(build()))
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
  const notes = once(() => ({ ...notesStoreOver(context), ...addedSourcesOver(context), ...noteSearchOver(context) }))
  const catalog = once(() => catalogStoreOver(context))
  const files = once(() => filesStoreOver(context))
  const calendar = once(() => ({ ...eventStoreOver(context), ...eventSearchOver(context) }))
  const meetingFindings = once(() => meetingFindingsStoreOver(context))
  const evidenceFindings = once(() => evidenceFindingsStoreOver(context))
  const mailFindings = once(() => mailFindingsStoreOver(context))
  const refs = refsStoreOver(context)
  const facts = once(() => factsStoreOver(context))
  const finance = once(() => financeStoreOver(context))
  const orders = once(() => ordersStoreOver(context))
  const deals = once(() => dealsStoreOver(context))
  const products = once(() => productsStoreOver(context))
  const contracts = once(() => contractsStoreOver(context))
  const subscriptions = once(() => subscriptionsStoreOver(context))
  const wallets = once(() => walletsStoreOver(context))
  const transactions = once(() => transactionsStoreOver(context))
  const crm = once(() => crmCopiesOver(context, accountPeopleOver(context)))
  const relations = once(() => relationsStoreOver(context))
  const decisionRequests = once(() => decisionRequestStoreOver(context))
  const records = once(() => recordStoreOver(context))
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
    refs,
    business: businessSearchOver(context),
    get evidenceFindings() {
      return evidenceFindings()
    },
    get mailFindings() {
      return mailFindings()
    },
    get facts() {
      return facts()
    },
    get finance() {
      return finance()
    },
    get orders() {
      return orders()
    },
    get deals() {
      return deals()
    },
    get products() {
      return products()
    },
    get contracts() {
      return contracts()
    },
    get subscriptions() {
      return subscriptions()
    },
    get wallets() {
      return wallets()
    },
    get transactions() {
      return transactions()
    },
    get crm() {
      return crm()
    },
    get relations() {
      return relations()
    },
    get decisionRequests() {
      return decisionRequests()
    },
    get records() {
      return records()
    },
    get memories() {
      return memories()
    },
    decisionPolicy: context.decisions ?? DEFAULT_DECISION_POLICY,
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
