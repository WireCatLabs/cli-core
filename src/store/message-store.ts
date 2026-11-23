import type { ContextEvidenceReader, ContextIndex, ContextRecordReader } from "../context/evidence.js"
import type { RefsStore } from "../domain/ref-summaries.js"
import type { EventStore } from "../meetings/index.js"
import type { AccountStore } from "./account-store.js"
import type { AccountsStore } from "./accounts.js"
import type { AttachmentsStore } from "./attachments.js"
import type { ChatsStore } from "./chats.js"
import type { ConversationsStore } from "./conversations.js"
import type { CountersStore } from "./counters.js"
import type { DecisionPolicy } from "./decisions.js"
import type { EvidenceFindingsStore } from "./evidence-findings.js"
import type { MailFindingsStore } from "./mail-findings.js"
import type { MeetingFindingsStore } from "./meeting-findings.js"
import type { MentionsStore } from "./mentions.js"
import type { MessagesStore } from "./messages.js"
import type { PeopleStore } from "./people.js"
import type { ProjectAnnotationStore } from "./project-transfer/store.js"
import type { QueriesStore } from "./queries.js"
import type { RosterStore } from "./roster.js"
import type { SearchIndexStore } from "./search-index.js"
import type { SearchesStore } from "./searches.js"
import type { AgentActionsStore } from "./sqlite/agent-actions.js"
import type { BaseStagesStore } from "./sqlite/base-stages.js"
import type { BotUpdateStore } from "./sqlite/bot-updates.js"
import type { ContractsStore } from "./sqlite/business-contracts.js"
import type { BusinessSearchStore } from "./sqlite/business-search.js"
import type { CatalogStore } from "./sqlite/catalog.js"
import type { ContentStore } from "./sqlite/content.js"
import type { CrmCopies } from "./sqlite/crm.js"
import type { CrmFileStore } from "./sqlite/crm-files.js"
import type { DealsStore } from "./sqlite/deals.js"
import type { DecisionRequestStore } from "./sqlite/decision-requests.js"
import type { DocumentListing } from "./sqlite/document-listing.js"
import type { MailStore } from "./sqlite/emails.js"
import type { EnrichmentStore } from "./sqlite/enrichments.js"
import type { EventSearch } from "./sqlite/event-search.js"
import type { FactsStore } from "./sqlite/facts.js"
import type { FilesStore } from "./sqlite/files.js"
import type { FinanceStore } from "./sqlite/finance.js"
import type { InvolvementStore } from "./sqlite/involvements.js"
import type { KnowledgeStore } from "./sqlite/knowledge.js"
import type { MeetingListing } from "./sqlite/meeting-listing.js"
import type { MeetingVectors } from "./sqlite/meeting-vectors.js"
import type { StoredMeetings } from "./sqlite/meetings.js"
import type { MemoriesStore } from "./sqlite/memories.js"
import type { SourceMentionStore } from "./sqlite/mention-sources.js"
import type { TransactionsStore } from "./sqlite/money-transactions.js"
import type { NotesStore } from "./sqlite/notes.js"
import type { OrdersStore } from "./sqlite/orders.js"
import type { ProductsStore } from "./sqlite/products.js"
import type { ProposedActionsStore } from "./sqlite/proposed-actions.js"
import type { RecordStore } from "./sqlite/records.js"
import type { RelationsStore } from "./sqlite/reported-relations.js"
import type { SubscriptionsStore } from "./sqlite/subscriptions.js"
import type { StoreTaskStore } from "./sqlite/tasks.js"
import type { TemplateStore } from "./sqlite/templates.js"
import type { TrackerStore } from "./sqlite/tracker.js"
import type { WalletsStore } from "./sqlite/wallets.js"
import type { SyncStore } from "./sync.js"
import type { TagsStore } from "./tags.js"
import type { AccountKey } from "./types.js"
import type { VectorsStore } from "./vectors.js"

export interface MessageStore {
  /** @experimental */
  readonly projectAnnotations?: ProjectAnnotationStore
  /** @experimental */
  readonly contextEvidence?: ContextEvidenceReader
  /** @experimental */
  readonly contextIndex?: ContextIndex
  /** @experimental */
  readonly contextRecords?: ContextRecordReader
  /** Accounts, account groups and which account each app profile is. */
  readonly accounts: AccountsStore
  /** One account's chats: the list, what left, what is complete, their metadata. */
  readonly chats: ChatsStore
  /** Sync markers, catch-up deltas, stretch leases and the stretches held completely. @experimental */
  readonly sync: SyncStore
  /** Messages: writes, reads, tombstones, reactions, transcripts and the plain text search. */
  readonly messages: MessagesStore
  /** Downloaded files and the text held of them. @experimental */
  readonly attachments: AttachmentsStore
  /** Who is in a chat, and its member history. @experimental */
  readonly roster: RosterStore
  /** People and contacts, the links between their identities, and the owner's private notes on them. */
  readonly people: PeopleStore
  /** Reply links, conversation builds and the user's agent's batches. @experimental */
  readonly conversations: ConversationsStore
  /** Chunk, image and picture vectors, and the nearest conversations by meaning. @experimental */
  readonly vectors: VectorsStore
  /** View, forward and reaction counters as they were observed. @experimental */
  readonly counters: CountersStore
  /** The search history and saved searches. @experimental */
  readonly searches: SearchesStore
  /** A resolved Lucene query run over the store. @experimental */
  readonly queries: QueriesStore
  /** The word index, the stems and the stemmer choices. @experimental */
  readonly searchIndex: SearchIndexStore
  /** Tags on chats, people and messages. */
  readonly tags: TagsStore
  /** Phones, addresses, links and documents found in messages, and the owner's decisions on them. @experimental */
  readonly mentions: MentionsStore
  /** Open tasks waiting on the owner, for the task service in `src/tasks/`. @experimental */
  readonly botUpdates: BotUpdateStore
  /** @experimental */
  readonly involvements: InvolvementStore
  /** @experimental */
  readonly tasks: StoreTaskStore
  /** Mentions in documents, notes and mail: memo lists and decides them. @experimental */
  readonly sourceMentions: SourceMentionStore
  /** @experimental */
  readonly knowledge: KnowledgeStore
  /** Notes, the links between anything and anything, and the owner's organisations and projects. @experimental */
  readonly notes: NotesStore
  /** @experimental */
  readonly catalog: CatalogStore
  /** Where each document is kept: its files, their folders and paths. @experimental */
  readonly files: FilesStore
  /**
   * Every document of every account, and every meeting, call and event as one row each: what a page lists.
   * @experimental */
  readonly listings: DocumentListing & MeetingListing
  /**
   * Calendars and their entries, the source records of events: the `EventStore` a calendar CLI writes through.
   * @experimental */
  readonly calendar: EventStore & EventSearch
  /** Choices that hold until replaced, each with its evidence. @experimental */
  readonly meetingFindings: MeetingFindingsStore
  /**
   * Cited facts and follow-ups about one project from stored messages, mail and documents, for review. @experimental
   */
  readonly evidenceFindings: EvidenceFindingsStore
  /** What an agent read in new mail, cited and staged per mailbox; only the owner decides it. @experimental */
  readonly mailFindings: MailFindingsStore
  /** What any ref names, a page of them at a time: read once per page, never once per row. @experimental */
  readonly refs: RefsStore
  /** @experimental */
  readonly facts: FactsStore
  /**
   * Invoices, payments and their allocations, in exact minor units; an agent's or an import's wait for the owner.
   * @experimental */
  readonly finance: FinanceStore
  /**
   * What the owner, his business or a client ordered and how far delivery got; an agent's wait for the owner.
   * @experimental */
  readonly orders: OrdersStore
  /** The owner's sales pipelines and the deals in them, written directly by the owner and his agents. @experimental */
  readonly deals: DealsStore
  /**
   * The owner's base stages of deals and of leads, and every other pipeline's stages mapped onto them. @experimental
   */
  readonly baseStages: BaseStagesStore
  /** What the owner or a supplier sells, with its price; written directly. @experimental */
  readonly products: ProductsStore
  /**
   * The contracts the owner works under; one with a value from an agent or an import waits for the owner. @experimental
   */
  readonly contracts: ContractsStore
  /** Subscriptions the owner bills or pays, with a price history never overwritten. @experimental */
  readonly subscriptions: SubscriptionsStore
  /** Bank accounts, cards and cash, with balances computed from their transactions. @experimental */
  readonly wallets: WalletsStore
  /**
   * What statements say moved on the wallets, split by category; an agent's or an import's wait for the owner.
   * @experimental */
  readonly transactions: TransactionsStore
  /** @experimental */
  readonly business: BusinessSearchStore
  /** A CRM account's pipelines, deals, leads, contacts and companies, written as the CRM has them. @experimental */
  readonly crm: CrmCopies
  /**
   * The CRM files the owner downloaded, with their text; only CRM code reads them, under the copy's viewer rule.
   * @experimental */
  readonly crmFiles: CrmFileStore
  /**
   * Issue trackers' copies: teams, users, states, labels, projects, issues and comments, as last synced. @experimental
   */
  readonly tracker: TrackerStore
  /**
   * Blogs' and social accounts' copies: channels, authors, terms, posts with their versions, and metrics. @experimental
   */
  readonly content: ContentStore
  /** Relationships a source account reports, written as a diff that never overrides the owner's. @experimental */
  readonly relations: RelationsStore
  /** The one-time keys behind the buttons of a message that asks the owner to decide a batch. @experimental */
  readonly decisionRequests: DecisionRequestStore
  /** The message templates the owner saved over the shipped ones, with every body a change replaced. @experimental */
  readonly templates: TemplateStore
  /** What each import said, by the source's identity; `ingest` (services) is the way in. @experimental */
  readonly records: RecordStore
  /** What agents concluded: summaries, digests, facts, preferences, each with evidence and a scope. @experimental */
  readonly memories: MemoriesStore
  /** What an agent wants done outside the store, waiting for the owner's approval. @experimental */
  readonly proposedActions: ProposedActionsStore
  /**
   * Who may decide proposals, fixed when the store was opened; the store's decide methods and the registry read it.
   * @experimental */
  readonly decisionPolicy: DecisionPolicy
  /** One row per tool an agent called, never its arguments. @experimental */
  readonly agentActions: AgentActionsStore
  /** Meetings and calendar events: the port `src/meetings/` defines. @experimental */
  readonly meetingVectors: MeetingVectors
  /** @experimental */
  readonly meetings: StoredMeetings
  /** Email threads, emails, recipients and mailboxes. @experimental */
  readonly mail: MailStore
  /**
   * What a hosted model wrote about notes, documents and mail, with the owner's consent; off by default. @experimental
   */
  readonly enrichment?: EnrichmentStore
  /** The same store with this account bound — what a service of one account reads and writes through. @experimental */
  forAccount(key: AccountKey): AccountStore
  close(): Promise<void>
}
