import { type BotCheckService, botCheckService } from "../botcheck/service.js"

export { type ChatCoverage, chatCoverage } from "./chat-coverage.js"
export type {
  ContextEvidenceItem,
  ContextEvidencePage,
  ContextEvidenceReader,
  ContextEvidenceRequest,
  ContextEvidenceSender,
  ContextIndex,
  ContextReadLimits,
  ContextReadUsage,
  ContextRecordReader,
  ContextSource,
  ScopedContextEvidenceReader,
} from "./context-evidence.js"
export { contextEvidenceFingerprint, createContextEvidenceReader } from "./context-evidence.js"
export { excerpt } from "./excerpt.js"
export type { MediaArchiveOptions, MediaArchivePorts } from "./media-archive.js"
export { archiveMedia, checkMediaArchive } from "./media-archive.js"
export type { MediaArchiveEntry, MediaIdentity } from "./media-archive-manifest.js"
export type { MoveMediaArchiveOptions } from "./media-archive-move.js"
export { moveMediaArchive } from "./media-archive-move.js"
export {
  type DownloadedModel,
  downloadImageModel,
  downloadTextModel,
  type ModelDownloadOptions,
} from "./model-downloads.js"
export type {
  ProjectEvidenceContext,
  ProjectEvidenceItem,
  ProjectEvidencePerson,
  ProjectGathering,
  ProjectGatheringPorts,
  ProjectGatheringStop,
  ProjectIndexCatchUp,
  ProjectSourceFetcher,
} from "./project-gathering.js"
export { gatherProjectEvidence } from "./project-gathering.js"
export type { ProjectNeighbour, ProjectNeighbourReader } from "./project-gathering-around.js"
export { documentPassage, storedMessageNeighbours, storedNeighbours } from "./project-gathering-around.js"
export type { EvidenceMention, EvidenceMentions } from "./project-gathering-mentions.js"
export { findEvidenceMentions } from "./project-gathering-mentions.js"
export type {
  ProjectFetchState,
  ProjectGatheringBudgets,
  ProjectGatheringRequest,
  ProjectLane,
  ProjectLaneKind,
  ProjectLinkedChat,
  ProjectPerson,
  ProjectSender,
  ProjectUnitState,
} from "./project-gathering-request.js"

import { type AccountService, accountService } from "./account.js"
import { type AdminService, adminService } from "./admin.js"
import { type AdminStatisticsService, adminStatisticsService } from "./admin-statistics.js"
import { type AgendaService, agendaService } from "./agenda.js"
import { type ArchiveService, archiveService } from "./archive.js"
import { gapsService } from "./archive-gaps.js"
import { type AttachmentsService, attachmentsService } from "./attachments.js"
import { type ChatDocumentsService, chatDocumentsService } from "./chat-documents.js"
import { type ChatsService, chatsService } from "./chats.js"
import { type ConversationsService, conversationsService } from "./conversations.js"
import { type CountersService, countersService } from "./counters.js"
import type { ServiceDeps } from "./deps.js"
import { type EmbeddingsService, embeddingsService } from "./embeddings.js"
import { type FoldersService, foldersService } from "./folders.js"
import { type InboxService, inboxService } from "./inbox.js"
import { type MentionsService, mentionsService } from "./mentions.js"
import { type MessagesService, messagesService } from "./messages.js"
import { metadataService } from "./metadata.js"
import { type ModerationService, moderationService } from "./moderation.js"
import { type PeopleService, peopleService } from "./people.js"
import { type PicturesService, picturesService, withPictures } from "./pictures.js"
import { privatePeopleService } from "./private-people.js"
import { type RankingsService, rankingsService } from "./rankings.js"
import { type RetentionService, retentionService } from "./retention.js"
import { type SearchesService, searchesService } from "./searches.js"
import { type TagsService, tagsService } from "./tags.js"
import { type TasksService, tasksService } from "./tasks.js"
import { type TopicsService, topicsService } from "./topics.js"

export type {
  MeetingProjectCandidateInput,
  MeetingProjectCandidateMatch,
  MeetingProjectCandidateOptions,
  MeetingProjectCandidateReader,
  MeetingProjectCandidates,
} from "../meetings/index.js"
export type { AccountService } from "./account.js"
export { accountService } from "./account.js"
export type { AdminService, NewGroup } from "./admin.js"
export { adminService } from "./admin.js"
export type { ArchiveService, Fetched, FetchOptions } from "./archive.js"
export { archiveService } from "./archive.js"
export type {
  AttachmentItem,
  AttachmentsService,
  AttachmentTextSet,
  ExtractItem,
  ExtractOptions,
  ExtractRun,
  ExtractStatus,
} from "./attachments.js"
export { attachmentsService } from "./attachments.js"
export type { ChatsService, MarkedRead, PageWindow } from "./chats.js"
export { chatsService, EVENTS_DAYS } from "./chats.js"
export type { BatchStatus, Built, ConversationsService, MessageLinks } from "./conversations.js"
export { BATCH_SIZE, conversationsService } from "./conversations.js"
export type { ServiceDeps, ServiceMessenger } from "./deps.js"
export { accountStore, crossAccount, OFFLINE, onlineDeps, storedDeps, storeOnlyDeps } from "./deps.js"
export type { Embedded, EmbeddingsService, EmbedStatus, FoundConversation } from "./embeddings.js"
export { embeddingsService } from "./embeddings.js"
export type { EvidenceKind, EvidenceMessage, EvidencePacket, EvidencePacketInput, EvidenceSource } from "./evidence.js"
export { prepareEvidencePacket } from "./evidence.js"
export type { EvidenceReadQuery, StoredEvidencePacket } from "./evidence-read.js"
export { readEvidencePacket } from "./evidence-read.js"
export type { FolderEdit, FoldersService } from "./folders.js"
export { foldersService } from "./folders.js"
export type { InboxService } from "./inbox.js"
export { inboxService } from "./inbox.js"
export { readMail } from "./mail-search.js"
export { type MeetingHitSearchRequest, refreshMeetingIndex, searchMeetingHits } from "./meeting-hit-search.js"
export { type MeetingLink, type MeetingLinksRequest, readMeetingLinks } from "./meeting-links.js"
export { createMeetingProjectCandidateReader } from "./meeting-project-candidates.js"
export { readMeetingProjectDiscovery } from "./meeting-project-discovery.js"
export { type MeetingReviewRequest, readMeetingReview } from "./meeting-review.js"
export {
  type MeetingSearchesService,
  type MeetingSearchParams,
  meetingSearchesService,
  type SavedMeetingSearch,
} from "./meeting-searches.js"
export { type MeetingStatsRequest, readMeetingStats } from "./meeting-stats.js"
export { chatIdIn, storedChatId } from "./message-resolution.js"
export type {
  AroundWindow,
  FoundMessage,
  ListWindow,
  MessagesService,
  MessageTarget,
  Pinned,
  Reacted,
  SearchFound,
  SearchQuery,
  SendRequest,
  Starred,
} from "./messages.js"
export { DELETE_AT_ONCE, messagesService } from "./messages.js"
export { searchStore } from "./messages-archive-search.js"
export type { ModerateOptions, ModerationService, ShownRules } from "./moderation.js"
export { moderationService } from "./moderation.js"
export type { ContactSync, PeopleService } from "./people.js"
export { linkPeople, peopleService, phoneOf } from "./people.js"
export type {
  ContextEvent,
  ContextMessage,
  ContextOptions,
  NotReadReason,
  PersonContext,
  SharedChat,
} from "./person-context.js"
export { CONTEXT_BYTES, CONTEXT_MESSAGES, identityIn, personContext } from "./person-context.js"
export type { PersonPreparation, WaitingDialog } from "./person-preparation.js"
export { PREPARE_BYTES, personPreparation } from "./person-preparation.js"
export type { PersonTimeline, Scope, TimelineItem, TimelineOptions } from "./person-timeline.js"
export { personTimeline, SCOPES, TIMELINE_ITEMS, TIMELINE_MAX } from "./person-timeline.js"
export type { RankedRow, RankingFound, RankingQuery, RankingsService } from "./rankings.js"
export { rankingsService } from "./rankings.js"
export type { SearchParams } from "./search-record.js"
export { searchRecordOf } from "./search-record.js"
export type { ResolvedSearch, SavedSearchItem, SearchesService } from "./searches.js"
export { savedSearchItem, searchesService } from "./searches.js"
export type { TagsAdded, TagsRemoved, TagsService, TagTargetInput, TagTargetView } from "./tags.js"
export { tagsService } from "./tags.js"
export type {
  ClosedTask,
  TaskCard,
  TaskItem,
  TaskList,
  TaskListRequest,
  TasksService,
  TaskView,
} from "./tasks.js"
export { closedStateOf, taskStateOf, tasksService, taskTypeOf, taskView } from "./tasks.js"
export { type TopicsService, topicsService } from "./topics.js"

export interface Services {
  metadata: ReturnType<typeof metadataService>
  privatePeople: ReturnType<typeof privatePeopleService>
  adminStatistics: AdminStatisticsService
  counters: CountersService
  retention: RetentionService
  rankings: RankingsService
  topics: TopicsService
  messages: MessagesService
  chats: ChatsService
  chatDocuments: ChatDocumentsService
  mentions: MentionsService
  people: PeopleService
  inbox: InboxService
  archive: ArchiveService
  gaps: ReturnType<typeof gapsService>
  admin: AdminService
  folders: FoldersService
  account: AccountService
  moderation: ModerationService
  conversations: ConversationsService
  embeddings: EmbeddingsService
  pictures: PicturesService
  tags: TagsService
  searches: SearchesService
  tasks: TasksService
  agenda: AgendaService
  attachments: AttachmentsService
  botcheck: BotCheckService
}

/**
 * How a CLI replaces a use case: it returns the services it changes, whole, and can call the shared
 * method inside its own — `messages: { ...base.messages, list: (chat, window) => … base.messages.list … }`.
 */
export type Override = (base: Services, deps: ServiceDeps) => Partial<Services>

/** The shared services, with the messenger's `services` override applied — commands and MCP tools alike. */
export const servicesFor = (deps: ServiceDeps): Services => {
  const pictures = picturesService(deps)
  const base: Services = {
    metadata: metadataService(deps),
    privatePeople: privatePeopleService(deps),
    adminStatistics: adminStatisticsService(deps),
    counters: countersService(deps),
    retention: retentionService(deps),
    rankings: rankingsService(deps),
    topics: topicsService(deps),
    messages: withPictures(messagesService(deps), pictures),
    chats: chatsService(deps),
    chatDocuments: chatDocumentsService(deps),
    mentions: mentionsService(deps),
    people: peopleService(deps),
    inbox: inboxService(deps),
    archive: archiveService(deps),
    gaps: gapsService(deps),
    admin: adminService(deps),
    folders: foldersService(deps),
    account: accountService(deps),
    moderation: moderationService(deps),
    conversations: conversationsService(deps),
    embeddings: embeddingsService(deps),
    pictures,
    tags: tagsService(deps),
    attachments: attachmentsService(deps),
    searches: searchesService(deps),
    tasks: tasksService(deps),
    agenda: agendaService(deps),
    botcheck: botCheckService(deps),
  }
  return deps.messenger.services ? { ...base, ...deps.messenger.services(base, deps) } : base
}

export { entriesOfList, type ListContext, type ListedEntry } from "../search/account-list.js"
export { FIELD_VERSION, QUERY_FIELDS, QUERY_OPERATORS, validateAst } from "../search/lucene/registry.js"
export { QUERY_LIMITS, QUERY_VERSION } from "../search/lucene/types.js"
export { type SearchTotal, TOTAL_CAP } from "../search/total.js"
export { TASK_KINDS, TASK_ORIGINS, type TaskKind, type TaskOrigin } from "../tasks/index.js"
export type { AdminFound, AdminQuery, AdminSelection, AdminStatisticsService } from "./admin-statistics.js"
export { adminStatisticsService } from "./admin-statistics.js"
export { GAP_BOUNDS, type GapPlan, type GapRepair, gapsService, type RepairOptions } from "./archive-gaps.js"
export type { CounterQuery, CountersService } from "./counters.js"
export { countersService } from "./counters.js"
export {
  type DocumentTarget,
  openPictureEmbedderFor,
  type PictureOptions,
  removePicture,
  savePicture,
} from "./document-pictures.js"
export type { ModelChoice } from "./embeddings.js"
export {
  calendarAccounts,
  type EventsFound,
  type EventsQuery,
  type FoundEvent,
  foundEvent,
  searchEvents,
} from "./events-search.js"
export { createMeetingBatchReader } from "./meeting-batch.js"
export {
  type MeetingCombinedHit,
  type MeetingCombinedRequest,
  searchMeetingsCombined,
} from "./meeting-combined.js"
export type {
  MeetingCommunicationCoverage,
  MeetingCommunicationExcerpt,
  MeetingCommunications,
  MeetingCommunicationsPort,
  MeetingCommunicationsRequest,
} from "./meeting-communications-types.js"
export {
  createMeetingContextService,
  type MeetingContextService,
  type MeetingContextServiceStore,
} from "./meeting-context.js"
export {
  type MeetingEvidenceCue,
  type MeetingEvidenceOptions,
  type MeetingEvidencePacket,
  readMeetingEvidence,
} from "./meeting-evidence.js"
export {
  type MeetingContextCue,
  type MeetingHitContextOptions,
  type MeetingHitContextPacket,
  meetingHitContextLimits,
  readMeetingHitContext,
} from "./meeting-hit-context.js"
export {
  createMeetingRemoteModel,
  type MeetingEmbedder,
  type MeetingEmbedderOptions,
  type MeetingEmbeddingModel,
  meetingEmbeddingModel,
  openMeetingEmbedder,
} from "./meeting-model.js"
export { formatMeetingPassage, type MeetingPassageFormat, readMeetingPassage } from "./meeting-passage-format.js"
export { createMeetingPreparationService } from "./meeting-preparation.js"
export type {
  MeetingPreparation,
  MeetingPreparationEntry,
  MeetingPreparationPorts,
  MeetingPreparationRequest,
} from "./meeting-preparation-types.js"
export { MEETING_PREPARATION_LIMITS, validateMeetingPreparationRequest } from "./meeting-preparation-validation.js"
export {
  type MeetingReadStore,
  type MeetingReferenceReadOptions,
  type ResolvedMeetingReference,
  resolveMeetingReference,
} from "./meeting-reference.js"
export {
  applyMeetingEmbedding,
  type MeetingEmbeddingApplyOptions,
  type MeetingSemanticOptions,
  proposeMeetingEmbedding,
  readMeetingSemantic,
} from "./meeting-semantic.js"
export { type MeetingTaskProposal, proposeMeetingTask } from "./meeting-task-proposal.js"
export {
  type CreateMeetingTaskInput,
  createTaskFromMeeting,
  type MeetingTaskSourceView,
  type MeetingTaskStore,
  type MeetingTaskView,
  readMeetingTask,
} from "./meeting-tasks.js"
export type { MeaningLane, MeaningSkipped } from "./messages-discovery.js"
export { meaningLane } from "./messages-meaning.js"
export type { QueryMetadata, SearchCoverage } from "./messages-search.js"
export { metadataService } from "./metadata.js"
export {
  embedEvents,
  embedMail,
  embedNotes,
  type FoundNote,
  type LinkedRecord,
  type NotesEmbedded,
  type NotesEmbedOptions,
  type NotesFound,
  type NotesFoundOf,
  type NotesQuery,
  type NotesSearchRequest,
  nearestNotes,
  RANK_WITHIN,
  searchNotes,
  searchNotesOf,
  searchNotesQuery,
  storeQuery,
} from "./notes-search.js"
export {
  type PackageUpgradeOutcome,
  type PackageUpgradePorts,
  type PackageUpgradeResult,
  type ServerRestarts,
  upgradePackage,
} from "./package-upgrade.js"
export {
  type PersonMeetingContext,
  type PersonMeetingContextItem,
  type PersonMeetingContextOptions,
  type PersonMeetingReadStore,
  personMeetingContext,
} from "./person-meeting-context.js"
export { privatePeopleService } from "./private-people.js"
export { approveAsTask, type ProposalTaskStore, proposalSource } from "./proposal-tasks.js"
export type { RetentionQuery, RetentionService } from "./retention.js"
export { retentionService } from "./retention.js"
export {
  RESOURCES_SEARCHED,
  type SearchAllFound,
  type SearchAllItem,
  type SearchAllMessenger,
  type SearchAllRequest,
  type SearchedResource,
  searchAll,
} from "./search-all.js"
export {
  type MeetingSearchCoverage,
  type MeetingSearchCursor,
  type MeetingSearchItem,
  RESOURCES_SEARCHED_WITH_MEETINGS,
  type ResourceWithMeetings,
  type SearchAllIncludingMeetingsFound,
  type SearchAllIncludingMeetingsRequest,
  type SearchAllWithMeetingsRequest,
  searchAllIncludingMeetings,
  searchAllWithMeetings,
} from "./search-all-meetings.js"
export {
  CATCH_UP_BOUNDS,
  type CatchUpOptions,
  type CatchUpResult,
  catchUpSearch,
  validateCatchUp,
} from "./search-catchup.js"
export { accountsOfKind, listContextOf, type SearchKind } from "./search-kind.js"
export type { SearchRefreshed, SyncOptions } from "./search-refresh.js"
export { SYNC_BOUNDS, SYNC_KEY } from "./search-refresh.js"
export {
  type Backend,
  type HitSource,
  SERVER_BOUNDS,
  SERVER_SEARCH_KEY,
  type ServerSearched,
} from "./server-search.js"
export type {
  StoredMeetingProjectCandidateOptions,
  StoredMeetingProjectCandidatePorts,
  StoredMeetingProjectCandidateReader,
  StoredMeetingProjectCandidates,
} from "./stored-meeting-project-candidate-types.js"
export { createStoredMeetingProjectCandidateReader } from "./stored-meeting-project-candidates.js"
export { applyTaskRulesSinceLastPass, applyTaskRulesToStored, type RuleResult } from "./task-rules.js"
export type { ThreadContext, ThreadOptions } from "./thread-context.js"
export { readThreadContext, THREAD_BOUNDS } from "./thread-context.js"
