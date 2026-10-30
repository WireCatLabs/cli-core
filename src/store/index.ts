export type {
  ContextEvidenceItem,
  ContextEvidencePage,
  ContextEvidenceReader,
  ContextEvidenceRequest,
  ContextEvidenceSender,
  ContextSource,
} from "../context/evidence.js"
export {
  FACT_STATUSES,
  FACT_TYPES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  TASK_TYPES,
  WORK_TASK_TYPES,
} from "../domain/knowledge.js"
export type {
  TagConsolidationApplyOptions,
  TagConsolidationOptions,
  TagConsolidationPreview,
  TagConsolidationReceipt,
  TagConsolidationStore,
} from "../domain/tag-consolidation.js"
export type { TagRedirectIndex, TagRedirectResolution, TagRedirectSnapshot } from "../domain/tag-redirects.js"
export { createTagRedirectIndex } from "../domain/tag-redirects.js"
export { note } from "../entities/note.js"
export type {
  FindingEvidence,
  FindingOutcome,
  MeetingFactFinding,
  MeetingFinding,
  MeetingFindingsInput,
  MeetingFindingsReceipt,
  MeetingTaskFinding,
} from "../meetings/index.js"
export type { AccountMail, AccountMeetings, AccountStore } from "./account-store.js"
export type {
  DocumentTransferOptions,
  DocumentTransferPreview,
  DocumentTransferReceipt,
} from "./document-transfer/index.js"
export { applyDocumentTransfer, previewDocumentTransfer } from "./document-transfer/index.js"
export type { CacheDatabase, CacheStatement, OpenDatabase, SqlValue } from "./driver.js"
export { PRAGMAS } from "./driver.js"
export {
  EVIDENCE_FINDINGS_KIND,
  type EvidenceFindingsBatch,
  type EvidenceFindingsDecider,
  type EvidenceFindingsReceipt,
  type EvidenceFindingsStore,
  validateEvidenceFindings,
} from "./evidence-findings.js"
export {
  ORGANIZATIONS_QUERY,
  organization,
  PROJECTS_QUERY,
  project,
  REMINDERS_QUERY,
  reminder,
} from "./knowledge-query.js"
export type { MeetingFindingsBatch, MeetingFindingsStore } from "./meeting-findings.js"
export { MIGRATIONS, type Migration, migrate } from "./migrations.js"
export { openCache } from "./open.js"
export { storePath } from "./path.js"
export {
  decodeProjectAnnotations,
  PROJECT_ANNOTATIONS_MAX_BYTES,
  type ProjectAnnotations,
  projectAnnotationsFingerprint,
} from "./project-transfer/manifest.js"
export {
  type ProjectAnnotationsPlan,
  type ProjectAnnotationsTarget,
  planProjectAnnotations,
} from "./project-transfer/plan.js"
export {
  type ProjectAnnotationPreview,
  type ProjectAnnotationPreviewOptions,
  previewProjectAnnotationSnapshot,
} from "./project-transfer/preview.js"
export {
  decodeProjectAnnotationSnapshot,
  type ProjectAnnotationSnapshot,
  type ProjectAnnotationSnapshotOptions,
  type ProjectAnnotationSnapshotResult,
  projectAnnotationSnapshotFingerprint,
  projectAnnotationSnapshotSchema,
  snapshotProjectAnnotations,
} from "./project-transfer/snapshot.js"
export { planProjectAnnotationSnapshot } from "./project-transfer/snapshot-plan.js"
export type {
  ProjectAnnotationRestoreReceipt,
  ProjectAnnotationRestoreRequest,
  ProjectAnnotationStore,
  ProjectAnnotationTargetRequest,
} from "./project-transfer/store.js"
export type { AgentAction, AgentActionInput, AgentActionsStore } from "./sqlite/agent-actions.js"
export { resetAttachmentWords } from "./sqlite/attachment-texts.js"
export { backfillNormalized, pendingNormalization } from "./sqlite/backfill.js"
export type { BotUpdate, BotUpdateStore } from "./sqlite/bot-updates.js"
export type { CatalogActor, CatalogEntry, CatalogInput, CatalogQuery, CatalogStore } from "./sqlite/catalog.js"
export { CATALOG_QUERY } from "./sqlite/catalog.js"
export type { ChatMetadata } from "./sqlite/chats.js"
export type {
  Email,
  EmailAddress,
  EmailAttachment,
  EmailFacts,
  EmailFilter,
  EmailInput,
  EmailInThread,
  EmailLocationInput,
  EmailRecipient,
  EmailRef,
  EmailThread,
  EmailVectorHit,
  FolderEmail,
  Mailbox,
  MailboxInput,
  MailFilter,
  MailStore,
  SenderScore,
  ThreadDetails,
  ThreadSave,
} from "./sqlite/emails.js"
export {
  EVENT_FIELDS,
  type EventChunkToEmbed,
  type EventHit,
  type EventQuery,
  type EventSearch,
  type NearestEvent,
} from "./sqlite/event-search.js"
export type { Fact, FactInput, FactsStore } from "./sqlite/facts.js"
export type { FileListQuery, FilesStore, StoredFile } from "./sqlite/files.js"
export { IMPORTED_DOCUMENT_QUERY, type ImportedDocuments } from "./sqlite/imported-documents.js"
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
export type { MailRule, MailRuleCount, MailRuleInput, MailRulesStore } from "./sqlite/mail-rules.js"
export type { MeetingProjectLink, MeetingProjectsStore } from "./sqlite/meeting-projects.js"
export type {
  MeetingContextReadCapabilities,
  MeetingReadCapabilities,
  MeetingReadScope,
  TranscriptContextInput,
  TranscriptContextPage,
  TranscriptPage,
  TranscriptReadScope,
  TranscriptRowPage,
} from "./sqlite/meeting-reads.js"
export type { MeetingVectorHit, MeetingVectors } from "./sqlite/meeting-vectors.js"
export type { AttachmentInput } from "./sqlite/meetings.js"
export type { Author, MemoriesStore, Memory, MemoryInput } from "./sqlite/memories.js"
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
  LinkListFilter,
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
export type { SimilarSubject, SimilarTask, TaskDraft } from "./sqlite/task-candidates.js"
export { type AgentCloseSettings, type CloseSuggestion, certaintyOf } from "./sqlite/task-close.js"
export type { TaskPair, TaskPairDecision, TaskPairSide } from "./sqlite/task-pairs.js"
export { TASK_PAIR_DECISIONS } from "./sqlite/task-pairs.js"
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
export { TASK_EVENT_KINDS, TASK_ROLES } from "./sqlite/work-tasks.js"
export {
  type AccountAccounts,
  type AccountAttachments,
  type AccountCounters,
  type AccountKey,
  type AccountMentions,
  type AccountMessageFilter,
  type AccountMessages,
  type AccountPeople,
  type AccountsStore,
  type AccountVectors,
  type AttachmentsStore,
  type AttachmentTextEntry,
  type AttachmentView,
  type ChatStats,
  type ChatsStore,
  type ConversationsStore,
  type CountersStore,
  type DeletionScope,
  type Delta,
  type FileAttachment,
  type IdentityRef,
  type IngestedVia,
  type LinkedIdentity,
  type LinkOptions,
  MENTION_QUERY,
  MENTION_STATUSES,
  type MentionsStore,
  type MessageFilter,
  type MessageStore,
  type MessagesStore,
  OTHER_SOURCES,
  openStore,
  type PeopleStore,
  type PersonFacts,
  type PersonRecord,
  type QueriesStore,
  type Range,
  type RankedEvidence,
  type RankedStoreFound,
  type RankedStoreRow,
  type RankingEvidenceItem,
  type RankingEvidenceRequest,
  type RankingRequest,
  type RosterStore,
  type SearchCommand,
  type SearchesStore,
  type SearchIndexStore,
  type SearchRecord,
  type StoredAccount,
  type StoredChatFilter,
  type StoredHit,
  type StoredSearch,
  type StoredTag,
  type StoreOptions,
  type SyncStore,
  type TagFilter,
  type TagsStore,
  type TagTarget,
  type TaskTagTarget,
  type TextOrigin,
  type VectorsStore,
} from "./store.js"
