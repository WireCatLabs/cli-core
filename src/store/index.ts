export type {
  ContextEvidenceItem,
  ContextEvidencePage,
  ContextEvidenceReader,
  ContextEvidenceRequest,
  ContextEvidenceSender,
  ContextSource,
} from "../context/evidence.js"
export { BUSINESS_KINDS, type BusinessKind } from "../domain/business.js"
export {
  FACT_STATUSES,
  FACT_TYPES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  TASK_TYPES,
  WORK_TASK_TYPES,
} from "../domain/knowledge.js"
export { type KindSignal, PERSON_KINDS, type PersonKind } from "../domain/person-kinds.js"
export type { RefState, RefSummary, RefSummaryKind, RefsStore } from "../domain/ref-summaries.js"
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
export { PAYMENT_DIRECTIONS, PAYMENT_STATES, type Payment, paymentTitle, validatePayment } from "../meetings/index.js"
export {
  CLOSED_STATES,
  isClosedState,
  PRIORITY_LABELS,
  type PriorityLabel,
  priorityLabel,
  priorityOf,
  priorityOption,
  TASK_STATES,
  type TaskState,
} from "../tasks/index.js"
export type { AccountMail, AccountMeetings, AccountStore } from "./account-store.js"
export {
  type DamageCause,
  type DamageFindings,
  type RecoveryStep,
  type StoreDamageReport,
  storeDamageReport,
} from "./damage.js"
export {
  CALLBACK_PREFIX,
  callbackDataOf,
  DECISION_ACTIONS,
  DECISION_TTL_MS,
  type DecisionAction,
  isDecisionToken,
  parseCallbackData,
} from "./decision-requests.js"
export {
  assertMayDecide,
  DEFAULT_DECISION_POLICY,
  type Decider,
  type DecisionPolicy,
  isOwnerOnlyKind,
  mayDecide,
  type Proposer,
  type Refusal,
} from "./decisions.js"
export type {
  DocumentTransferOptions,
  DocumentTransferPreview,
  DocumentTransferReceipt,
} from "./document-transfer/index.js"
export { applyDocumentTransfer, previewDocumentTransfer } from "./document-transfer/index.js"
export type { CacheDatabase, CacheStatement, OpenDatabase, SqlValue } from "./driver.js"
export { PRAGMAS } from "./driver.js"
export {
  type CitableRecord,
  EVIDENCE_FINDINGS_KIND,
  type EvidenceFindingsBatch,
  type EvidenceFindingsDecider,
  type EvidenceFindingsReceipt,
  type EvidenceFindingsStore,
  validateEvidenceFindings,
} from "./evidence-findings.js"
export {
  type DamagedTable,
  type InvalidJson,
  QUICK_HEALTH_CHECKS,
  type SearchIndexHealth,
  type StoreHealth,
  storeHealth,
} from "./health.js"
export {
  IDENTITY_LINK_KIND,
  IDENTITY_LINK_SIGNALS,
  type IdentityLinkDecision,
  type IdentityLinkFilter,
  type IdentityLinkInput,
  type IdentityLinkPayload,
  type IdentityLinkRow,
  type IdentityLinkSignal,
  type MatchScan,
} from "./identity-links.js"
export {
  IDENTITY_SPLIT_KIND,
  type IdentitySplitDecision,
  type IdentitySplitFilter,
  type IdentitySplitInput,
  type IdentitySplitMove,
  type IdentitySplitPayload,
  type IdentitySplitRow,
} from "./identity-splits.js"
export {
  ORGANIZATIONS_QUERY,
  organization,
  PROJECTS_QUERY,
  project,
  REMINDERS_QUERY,
  reminder,
} from "./knowledge-query.js"
export {
  MAIL_FINDINGS_KIND,
  type MailFindingsBatch,
  type MailFindingsCheck,
  type MailFindingsStore,
} from "./mail-findings.js"
export {
  clearDamageMark,
  type DamageMark,
  damageMarkPath,
  type HealthMark,
  healthMarkPath,
  type JournalMark,
  journalMarkPath,
  markStoreDamaged,
  readDamageMark,
  readHealthMark,
  readJournalMark,
  recordDeepCheck,
} from "./marks.js"
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
export {
  type ChangedSource,
  SOURCE_REVIEW_CAUSES,
  SOURCE_REVIEW_KIND,
  type SourceCheck,
  type SourceReviewCause,
  type SourceReviewChallenge,
  type SourceReviewMarker,
  type SourceReviewPayload,
  type SourceReviewSource,
  type SourceReviewText,
} from "./source-review.js"
export {
  ADDED_KINDS,
  type AddedSource,
  type AddedSourceContent,
  type AddedSourceDetails,
  type AddedSourceInput,
  addedSourceKeyOf,
} from "./sqlite/added-sources.js"
export type { AgentAction, AgentActionInput, AgentActionsStore } from "./sqlite/agent-actions.js"
export { resetAttachmentWords } from "./sqlite/attachment-texts.js"
export { backfillNormalized, pendingNormalization } from "./sqlite/backfill.js"
export type {
  BaseColumn,
  BaseScope,
  BaseSet,
  BaseStagesStore,
  MappingFilter,
  StageMapping,
  StageName,
} from "./sqlite/base-stages.js"
export { baseSettingKey } from "./sqlite/base-suggest.js"
export type { BotUpdate, BotUpdateStore } from "./sqlite/bot-updates.js"
export type {
  Contract,
  ContractFields,
  ContractFilter,
  ContractInput,
  ContractsStore,
  ContractUpdate,
} from "./sqlite/business-contracts.js"
export type { BusinessHit, BusinessSearch, BusinessSearchStore, BusinessSource } from "./sqlite/business-search.js"
export { BUSINESS_FIND_MAX } from "./sqlite/business-search.js"
export type { CatalogActor, CatalogEntry, CatalogInput, CatalogQuery, CatalogStore } from "./sqlite/catalog.js"
export { CATALOG_QUERY } from "./sqlite/catalog.js"
export type { ChatMetadata } from "./sqlite/chats.js"
export {
  type CrmContactsRemoved,
  type CrmCopies,
  type CrmRelationIssue,
  type CrmSaved,
  type CrmSkipped,
  crmIdentityId,
} from "./sqlite/crm.js"
export {
  COMPANY_TYPE_MEANINGS,
  type CompanyTypeMeaning,
  CRM_LINK_MODES,
  type CrmLinkMode,
  crmSettingKey,
} from "./sqlite/crm-settings.js"
export type {
  Deal,
  DealFilter,
  DealInput,
  DealPerson,
  DealScope,
  DealsStore,
  FunnelStage,
  Pipeline,
  PipelineInput,
  PipelineReport,
  PipelineStage,
  StageChange,
} from "./sqlite/deals.js"
export type {
  DecisionMessage,
  DecisionPress,
  DecisionRefusal,
  DecisionRequest,
  DecisionRequestInput,
  DecisionRequestStore,
  TakeResult,
} from "./sqlite/decision-requests.js"
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
  PartialEmail,
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
export type { EvidenceInput, EvidenceMetadata } from "./sqlite/evidence-signature.js"
export { QUOTE_LIMIT, quoteKept } from "./sqlite/evidence-signature.js"
export type { EvidenceSource } from "./sqlite/evidence-sources.js"
export type { Fact, FactInput, FactsStore } from "./sqlite/facts.js"
export type { FileListQuery, FilesStore, StoredFile } from "./sqlite/files.js"
export type {
  Allocation,
  FinanceStore,
  Invoice,
  InvoiceDetail,
  InvoiceInput,
  InvoiceLine,
  InvoiceLineInput,
  OpenTotal,
  Payment as FinancePayment,
  PaymentDetail as FinancePaymentDetail,
  PaymentInput as FinancePaymentInput,
} from "./sqlite/finance.js"
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
export type { MoneyLine, MoneyLineInput } from "./sqlite/money-lines.js"
export type {
  CategoryTotal,
  MoneyTransaction,
  SplitInput,
  TransactionFilter,
  TransactionInput,
  TransactionSplit,
  TransactionsStore,
  TransactionUpdate,
} from "./sqlite/money-transactions.js"
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
export type { Order, OrderDetail, OrderFilter, OrderInput, OrdersStore } from "./sqlite/orders.js"
export type { OrganizationFilter } from "./sqlite/organization-categories.js"
export { DEFAULT_OWNER_LANGUAGES, ownerLanguages } from "./sqlite/owner-languages.js"
export {
  type ListedPerson,
  PEOPLE_SORTS,
  type PeopleList,
  type PeopleListOptions,
  type PeopleSort,
  type SimilarPerson,
} from "./sqlite/people-list.js"
export {
  DOUBT_REASONS,
  type DoubtIdentity,
  type DoubtMove,
  type DoubtReason,
  type PersonDoubt,
  type PersonDoubts,
} from "./sqlite/person-doubts.js"
export { mergeId, type PersonMerge, parseMergeId } from "./sqlite/person-merges.js"
export {
  ALWAYS_SHOWN,
  PERSON_TIES,
  type PersonTie,
  type ShownBecause,
  SMALL_GROUP_MEMBERS,
} from "./sqlite/person-ties.js"
export type { PrivateContact, PrivateContactNote } from "./sqlite/private-people.js"
export type { Product, ProductFilter, ProductInput, ProductsStore, ProductUpdate } from "./sqlite/products.js"
export {
  assertGenericAction,
  PROPOSAL_STATUSES,
  type ProposalInput,
  type ProposedAction,
  type ProposedActionsStore,
  proposerOfAction,
} from "./sqlite/proposed-actions.js"
export type { RelationshipCounts } from "./sqlite/record-relationships.js"
export {
  type FlaggedRecord,
  type IncomingRelation,
  type MappedRecord,
  type MatchRun,
  type RecordKey,
  type RecordStore,
  type RecordsRun,
  type RunItem,
  type RunOptions,
  type SourceRecord,
  type SourceRecordRelation,
  type Unmatched,
  waitingPointer,
} from "./sqlite/records.js"
export type { RelationFilter, RelationList, RelationListItem } from "./sqlite/relation-list.js"
export type { LinkDecision, RelationUpdate } from "./sqlite/relation-proposals.js"
export type { RelationReads } from "./sqlite/relation-reads.js"
export type { RelationRole, RelationRoles } from "./sqlite/relation-roles.js"
export type {
  RelationsStore,
  ReportedIssue,
  ReportedRelation,
  ReportedScope,
  ReportedSync,
} from "./sqlite/reported-relations.js"
export type { AuthorInfo, Party, Reviewed, Written } from "./sqlite/reviewed.js"
export {
  fillSearchIndex,
  resetSearchIndex,
  type SearchIndexFill,
  type SearchIndexState,
  searchIndexState,
} from "./sqlite/search-index.js"
export type { ChallengeInput, SourceReviewDecision } from "./sqlite/source-review.js"
export type {
  PriceFilter,
  PriceInput,
  Subscription,
  SubscriptionDetail,
  SubscriptionFields,
  SubscriptionFilter,
  SubscriptionInput,
  SubscriptionPrice,
  SubscriptionsStore,
  SubscriptionUpdate,
} from "./sqlite/subscriptions.js"
export type { SyncStateSave } from "./sqlite/sync.js"
export type { TagCreationOptions, TagCreationReview } from "./sqlite/tag-creation.js"
export type { TagKind, TagRow } from "./sqlite/tags.js"
export type { TaskSort } from "./sqlite/task-board.js"
export { PROJECT_TASK_FIELDS, TASK_SORTS, withoutField } from "./sqlite/task-board.js"
export type { SimilarSubject, SimilarTask, TaskDraft } from "./sqlite/task-candidates.js"
export { type AgentCloseSettings, type CloseSuggestion, certaintyOf } from "./sqlite/task-close.js"
export type { NamedAuthor, TaskComment } from "./sqlite/task-comments.js"
export type { TaskPair, TaskPairDecision, TaskPairSide } from "./sqlite/task-pairs.js"
export { TASK_PAIR_DECISIONS } from "./sqlite/task-pairs.js"
export type { TaskRelation, TaskRelationKind, TaskRelationsStore } from "./sqlite/task-relations.js"
export { TASK_RELATION_KINDS } from "./sqlite/task-relations.js"
export type { TaskStatRow, TaskStatScope } from "./sqlite/task-stats.js"
export type { StoreTaskStore } from "./sqlite/tasks.js"
export type { StoredTemplate, TemplateAddress, TemplateHistoryEntry, TemplateStore } from "./sqlite/templates.js"
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
export type { Wallet, WalletFilter, WalletInput, WalletsStore, WalletUpdate } from "./sqlite/wallets.js"
export type {
  BoardCounts,
  BoardOptions,
  EditedTask,
  MovedSubtask,
  NewWorkTask,
  RevisionCheck,
  TaskAssignment,
  TaskDetails,
  TaskEvent,
  TaskFields,
  TaskMove,
  TaskMoved,
  TaskRole,
  TaskType,
  WorkTaskType,
} from "./sqlite/work-tasks.js"
export { TASK_EVENT_KINDS, TASK_ROLES } from "./sqlite/work-tasks.js"
export {
  type AccountAccounts,
  type AccountAttachments,
  type AccountCounters,
  type AccountGroupChange,
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
  type ChatActivityCount,
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
  type TaskAnalysisMark,
  type TaskAnalysisMarkWrite,
  type TaskTagTarget,
  type TextOrigin,
  type VectorsStore,
} from "./store.js"
