import type {
  MeetingContextStore,
  MeetingSearchIndexStore,
  MeetingSearchStore,
  MeetingStore,
  MeetingTranscriptReceiptStore,
  MeetingTranscriptStore,
} from "../../meetings/index.js"
import type { MeetingReadCapabilities } from "../sqlite/meeting-reads.js"
import type { AgentActionsStore } from "./agent-actions-types.js"
import type { BotUpdateStore } from "./bot-updates-types.js"
import type { MailStore } from "./emails-types.js"
import type { FactsStore } from "./facts-types.js"
import type { InvolvementStore } from "./involvements-types.js"
import type { KnowledgeStore } from "./knowledge-types.js"
import type { MeetingVectors } from "./meeting-vectors-types.js"
import type { MemoriesStore } from "./memories-types.js"
import type { NotesStore } from "./notes-types.js"
import type { ProposedActionsStore } from "./proposed-actions-types.js"
import type { StoreTaskStore } from "./tasks-types.js"

export interface SourcesStore {
  /** Open tasks waiting on the owner, for the task service in `src/tasks/`. */
  readonly botUpdates: BotUpdateStore

  readonly involvements: InvolvementStore

  readonly tasks: StoreTaskStore

  readonly knowledge: KnowledgeStore

  /** Notes, the links between anything and anything, and the owner's organisations and projects. */
  readonly notes: NotesStore

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

  readonly meetings: MeetingStore &
    MeetingTranscriptStore &
    MeetingReadCapabilities &
    MeetingSearchStore &
    MeetingTranscriptReceiptStore &
    MeetingContextStore &
    MeetingSearchIndexStore

  /** Email threads, emails, recipients and mailboxes. */
  readonly mail: MailStore
}
