export type { AccountMail, AccountMeetings, AccountStore } from "./account-store.js"
export type { CacheDatabase, CacheStatement, OpenDatabase, SqlValue } from "./driver.js"
export { PRAGMAS } from "./driver.js"
export { MIGRATIONS, type Migration, migrate } from "./migrations.js"
export { openCache } from "./open.js"
export { storePath } from "./path.js"
export type { AgentAction, AgentActionInput, AgentActionsStore } from "./sqlite/agent-actions.js"
export { resetAttachmentWords } from "./sqlite/attachment-texts.js"
export { backfillNormalized, pendingNormalization } from "./sqlite/backfill.js"
export type { BotUpdate, BotUpdateStore } from "./sqlite/bot-updates.js"
export type { ChatMetadata } from "./sqlite/chats.js"
export type {
  Email,
  EmailAddress,
  EmailAttachment,
  EmailFilter,
  EmailInput,
  EmailInThread,
  EmailRecipient,
  EmailThread,
  EmailVectorHit,
  Mailbox,
  MailboxInput,
  MailFilter,
  MailStore,
  ThreadDetails,
  ThreadSave,
} from "./sqlite/emails.js"
export type { Fact, FactInput, FactsStore } from "./sqlite/facts.js"
export { FACT_STATUSES, FACT_TYPES } from "./sqlite/facts.js"
export type { Involvement, InvolvementStore } from "./sqlite/involvements.js"
export type {
  Annotation,
  KnowledgeRelation,
  KnowledgeStore,
  KnowledgeTarget,
  LabelledType,
  Organization,
  Project,
  Reminder,
} from "./sqlite/knowledge.js"
export { ORGANIZATION_KINDS, PROJECT_TYPES, SCOPES } from "./sqlite/knowledge.js"
export type { MeetingProjectLink, MeetingProjectsStore } from "./sqlite/meeting-projects.js"
export type {
  MeetingReadCapabilities,
  MeetingReadScope,
  TranscriptPage,
  TranscriptReadScope,
  TranscriptRowPage,
} from "./sqlite/meeting-reads.js"
export type { MeetingVectorHit, MeetingVectors } from "./sqlite/meeting-vectors.js"
export type { AttachmentInput } from "./sqlite/meetings.js"
export type { Author, MemoriesStore, Memory, MemoryInput } from "./sqlite/memories.js"
export { MEMORY_KINDS, MEMORY_SCOPES, MEMORY_STATUSES } from "./sqlite/memories.js"
export type { NoteIndexState } from "./sqlite/note-index.js"
export {
  type NearestNote,
  NOTE_FIELDS,
  type NoteChunkToEmbed,
  type NoteHit,
  type NoteQuery,
  type NoteSearch,
} from "./sqlite/note-search.js"
export type {
  FileNoteInput,
  Link,
  LinkInput,
  Note,
  NoteFolder,
  NotesStore,
  NoteTag,
} from "./sqlite/notes.js"
export type { PrivateContact, PrivateContactNote } from "./sqlite/private-people.js"
export type { ProposalInput, ProposedAction, ProposedActionsStore } from "./sqlite/proposed-actions.js"
export { PROPOSAL_STATUSES } from "./sqlite/proposed-actions.js"
export {
  fillSearchIndex,
  resetSearchIndex,
  type SearchIndexFill,
  type SearchIndexState,
  searchIndexState,
} from "./sqlite/search-index.js"
export type { TagCreationOptions, TagCreationReview } from "./sqlite/tag-creation.js"
export type { TagKind, TagRow } from "./sqlite/tags.js"
export type { TaskRelation, TaskRelationKind, TaskRelationsStore } from "./sqlite/task-relations.js"
export { TASK_RELATION_KINDS } from "./sqlite/task-relations.js"
export type { StoreTaskStore } from "./sqlite/tasks.js"
export type {
  TagPreflight,
  VocabularyAlias,
  VocabularyAliasReceipt,
  VocabularyAudit,
  VocabularyAuditOptions,
  VocabularyCatalog,
  VocabularyEntry,
  VocabularyKind,
  VocabularyOptions,
  VocabularyResolution,
  VocabularyStore,
  VocabularyTarget,
} from "./sqlite/vocabulary.js"
export type {
  NewWorkTask,
  TaskAssignment,
  TaskDetails,
  TaskEvent,
  TaskFields,
  TaskRole,
  TaskType,
  WorkTaskType,
} from "./sqlite/work-tasks.js"
export { TASK_EVENT_KINDS, TASK_ROLES, TASK_TYPES, WORK_TASK_TYPES } from "./sqlite/work-tasks.js"
export {
  type AccountKey,
  type AccountMessageFilter,
  type AttachmentTextEntry,
  type AttachmentView,
  type ChatStats,
  type DeletionScope,
  type Delta,
  type FileAttachment,
  type IdentityRef,
  type IngestedVia,
  type LinkedIdentity,
  type LinkOptions,
  type MessageFilter,
  type MessageStore,
  openStore,
  type PersonFacts,
  type PersonRecord,
  type Range,
  type RankedEvidence,
  type RankedStoreFound,
  type RankedStoreRow,
  type RankingEvidenceItem,
  type RankingEvidenceRequest,
  type RankingRequest,
  type SearchCommand,
  type SearchRecord,
  type StoredAccount,
  type StoredChatFilter,
  type StoredHit,
  type StoredSearch,
  type StoredTag,
  type StoreOptions,
  type TagFilter,
  type TagTarget,
  type TextOrigin,
} from "./store.js"
