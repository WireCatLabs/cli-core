import type { ContextEvidenceReader } from "../context/evidence.js"
import type { AccountStore } from "./account-store.js"
import type { AccountsStore } from "./accounts.js"
import type { AttachmentsStore } from "./attachments.js"
import type { ChatsStore } from "./chats.js"
import type { ConversationsStore } from "./conversations.js"
import type { CountersStore } from "./counters.js"
import type { MeetingFindingsStore } from "./meeting-findings.js"
import type { MentionsStore } from "./mentions.js"
import type { MessagesStore } from "./messages.js"
import type { PeopleStore } from "./people.js"
import type { QueriesStore } from "./queries.js"
import type { RosterStore } from "./roster.js"
import type { SearchIndexStore } from "./search-index.js"
import type { SearchesStore } from "./searches.js"
import type { AgentActionsStore } from "./sqlite/agent-actions.js"
import type { BotUpdateStore } from "./sqlite/bot-updates.js"
import type { CatalogStore } from "./sqlite/catalog.js"
import type { MailStore } from "./sqlite/emails.js"
import type { FactsStore } from "./sqlite/facts.js"
import type { InvolvementStore } from "./sqlite/involvements.js"
import type { KnowledgeStore } from "./sqlite/knowledge.js"
import type { MeetingVectors } from "./sqlite/meeting-vectors.js"
import type { StoredMeetings } from "./sqlite/meetings.js"
import type { MemoriesStore } from "./sqlite/memories.js"
import type { SourceMentionStore } from "./sqlite/mention-sources.js"
import type { NotesStore } from "./sqlite/notes.js"
import type { StoreOptions } from "./sqlite/open-store.js"
import type { ProposedActionsStore } from "./sqlite/proposed-actions.js"
import type { StoreTaskStore } from "./sqlite/tasks.js"
import type { SyncStore } from "./sync.js"
import type { TagsStore } from "./tags.js"
import type { AccountKey } from "./types.js"
import type { VectorsStore } from "./vectors.js"

export interface MessageStore {
  readonly contextEvidence?: ContextEvidenceReader
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
  readonly meetingFindings: MeetingFindingsStore
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

export { BACKFILL_ON_OPEN, type StoreOptions } from "./sqlite/open-store.js"

/** Loads the store's modules on the first open, not when a command that may open one is defined. */
export const openStore = async (options: StoreOptions = {}): Promise<MessageStore> =>
  (await import("./message-store.js")).openStore(options)

export * from "./exports.js"
