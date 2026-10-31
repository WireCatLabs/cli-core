import { jsonSchemaOf } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { MEETING_RESULT_ENTITIES } from "../meetings/index.js"
import { account } from "./account.js"
import { accountChange, accountPrivacy, accountPrivacyChange, endedAccountSessions } from "./account-change.js"
import { accountProfile } from "./account-profile.js"
import { accountSession } from "./account-session.js"
import { adminReport } from "./admin-report.js"
import { agenda } from "./agenda.js"
import { analysisConsent, analysisConsentRevocation } from "./analysis-consent.js"
import { attachment } from "./attachment.js"
import { attachmentBytes, attachmentExtraction, attachmentTextChange } from "./attachment-results.js"
import { chart } from "./chart.js"
import { chat } from "./chat.js"
import {
  chatAdminChange,
  chatFolderChange,
  chatFolderOrder,
  chatFolderRemoval,
  chatGroupChange,
  chatInspection,
  chatInvite,
  chatInviteChange,
  chatMembersChange,
  chatMembersFetch,
  chatRead,
  chatRequestChange,
  chatSender,
} from "./chat-admin.js"
import { chatArchive, chatMuting, chatPin, chatRemoval, chatUnread } from "./chat-change.js"
import { chatEvent } from "./chat-event.js"
import { cachedChatMetadata, chatMetadata, chatMetadataRefresh } from "./chat-metadata.js"
import { chatModeration, chatRules } from "./chat-moderation.js"
import { chatStats, taskStats } from "./chat-stats.js"
import { chatTracking, trackedChat, trackedChatHistory } from "./chat-tracking.js"
import { contact } from "./contact.js"
import { contactActivity, contactCheck, linkedPerson } from "./contact-activity.js"
import { contactContext, contactPreparation } from "./contact-context.js"
import { contactNote } from "./contact-note.js"
import { contactLookup, contactSync } from "./contact-read.js"
import { contactImport, contactStateChange, contactUpdate } from "./contact-write.js"
import { conversation } from "./conversation.js"
import { conversationPreparation } from "./conversation-preparation.js"
import {
  conversationBatch,
  conversationBatchStatus,
  conversationBuildResult,
  conversationChange,
  conversationDetails,
  conversationEmbedding,
  conversationEmbeddingStatus,
  conversationHit,
  conversationReadiness,
} from "./conversation-results.js"
import { counterRefresh, counters } from "./counters.js"
import { document } from "./document.js"
import { documentLink } from "./document-link.js"
import { evidence } from "./evidence.js"
import { fact } from "./fact.js"
import { reference, untrusted } from "./fields.js"
import { folder } from "./folder.js"
import { hit } from "./hit.js"
import { identity } from "./identity.js"
import { imageEmbedding } from "./image-embedding.js"
import { inviteLink } from "./invite-link.js"
import { job } from "./job.js"
import { joinRequest } from "./join-request.js"
import { organization, project, reminder } from "./knowledge-lists.js"
import {
  botAdmin,
  botMenuEntry,
  botProfile,
  botSeenChat,
  botTemplate,
  botWebhook,
  callRecord,
  scheduledJob,
  stickerInventory,
} from "./list-results.js"
import { messageEvent, serveSummary, watchedMessage, watchItem } from "./listener.js"
import { mediaArchive, mediaArchiveCheck, mediaArchiveMove, mediaArchiveTimer } from "./media-archive.js"
import {
  event,
  meeting,
  meetingDetails,
  meetingHit,
  meetingLink,
  meetingParticipants,
  meetingPassage,
  meetingProjectEvidence,
  meetingReview,
  meetingSpeaker,
  meetingStats,
  meetingSummary,
  meetingTranscript,
} from "./meeting.js"
import { meetingEvidence, meetingPersonContext } from "./meeting-evidence.js"
import { meetingFindings } from "./meeting-findings.js"
import { meetingPreparation } from "./meeting-preparation.js"
import { meetingProjectCandidates } from "./meeting-project-candidates.js"
import { meetingSeriesInventory } from "./meeting-series-inventory.js"
import { meetingTaskProposal } from "./meeting-task-proposal.js"
import { member } from "./member.js"
import { memory } from "./memory.js"
import { mention, mentionDecision, mentionDetails, mentionDomain, mentionRebuild, place } from "./mention.js"
import { message } from "./message.js"
import { messageDeletion, messagePin, messageStar } from "./message-change.js"
import { messageContext } from "./message-context.js"
import { messageCounts } from "./message-counts.js"
import { messageLink } from "./message-link.js"
import { evidencePacket, messageLinks, messageTranscript } from "./message-read.js"
import { messageDownload, messageSync } from "./message-transfer.js"
import { messageSend, messageWrite } from "./message-write.js"
import { model } from "./model.js"
import { modelKey, removedModelKey, storedModelKey } from "./model-key.js"
import { note } from "./note.js"
import { officialStats } from "./official-stats.js"
import { person } from "./person.js"
import { poll, pollChange } from "./poll.js"
import { pollVote } from "./poll-vote.js"
import { contactAlias, contactNoteRemoval } from "./private-contact.js"
import { ranking } from "./ranking.js"
import { reaction } from "./reaction.js"
import { reactionChange } from "./reaction-change.js"
import { recipient, recipientAdded, recipientChange, recipientOff, recipientRemoved } from "./recipient.js"
import { recordedRun, runDetails, runHit, runLocation } from "./recorded-run.js"
import { relationship } from "./relationship.js"
import { retention } from "./retention.js"
import { savedSearch, searchHistoryClear } from "./saved-search.js"
import { sendAttempt } from "./send-attempt.js"
import {
  storeBackup,
  storeCheck,
  storeCopyRemoval,
  storeDecrypt,
  storeInfo,
  storeMigration,
  storeReindex,
  storeRepair,
  storeReset,
  storeRestore,
} from "./store-maintenance.js"
import {
  storeChatStatus,
  storeClear,
  storeExport,
  storeGapPlan,
  storeGapRepair,
  storeJobCancel,
  storeJobClear,
  storeJobDetails,
  storeJobRetry,
  syncProgress,
} from "./store-records.js"
import { storeTable } from "./store-table.js"
import { automaticTags, tagChange } from "./tag-change.js"
import { tagging } from "./tagging.js"
import { task } from "./task.js"
import { taskPair } from "./task-pair.js"
import {
  taskCard,
  taskCategories,
  taskClosed,
  taskCreated,
  taskLinks,
  taskMerge,
  taskScan,
  taskSimilar,
  taskUnmerge,
} from "./task-results.js"
import { topic } from "./topic.js"

/**
 * One schema per thing a command can answer with. A command returns an entity or one of its views — a
 * subset of its fields, never a renamed one. Commands move onto these one by one; until then, a schema
 * is the target, not a description of today's output.
 */

export {
  account,
  accountChange,
  accountPrivacy,
  accountPrivacyChange,
  accountProfile,
  accountSession,
  adminReport,
  agenda,
  analysisConsent,
  analysisConsentRevocation,
  attachment,
  attachmentBytes,
  attachmentExtraction,
  attachmentTextChange,
  automaticTags,
  botAdmin,
  botMenuEntry,
  botProfile,
  botSeenChat,
  botTemplate,
  botWebhook,
  cachedChatMetadata,
  callRecord,
  chart,
  chat,
  chatAdminChange,
  chatArchive,
  chatEvent,
  chatFolderChange,
  chatFolderOrder,
  chatFolderRemoval,
  chatGroupChange,
  chatInspection,
  chatInvite,
  chatInviteChange,
  chatMembersChange,
  chatMembersFetch,
  chatMetadata,
  chatMetadataRefresh,
  chatModeration,
  chatMuting,
  chatPin,
  chatRead,
  chatRemoval,
  chatRequestChange,
  chatRules,
  chatSender,
  chatStats,
  chatTracking,
  chatUnread,
  contact,
  contactActivity,
  contactAlias,
  contactCheck,
  contactContext,
  contactImport,
  contactLookup,
  contactNote,
  contactNoteRemoval,
  contactPreparation,
  contactStateChange,
  contactSync,
  contactUpdate,
  conversation,
  conversationBatch,
  conversationBatchStatus,
  conversationBuildResult,
  conversationChange,
  conversationDetails,
  conversationEmbedding,
  conversationEmbeddingStatus,
  conversationHit,
  conversationPreparation,
  conversationReadiness,
  counterRefresh,
  counters,
  document,
  documentLink,
  endedAccountSessions,
  evidence,
  evidencePacket,
  fact,
  folder,
  hit,
  identity,
  imageEmbedding,
  inviteLink,
  job,
  joinRequest,
  linkedPerson,
  mediaArchive,
  mediaArchiveCheck,
  mediaArchiveMove,
  mediaArchiveTimer,
  meeting,
  meetingProjectCandidates,
  meetingSeriesInventory,
  member,
  memory,
  mention,
  mentionDecision,
  mentionDetails,
  mentionDomain,
  mentionRebuild,
  message,
  messageContext,
  messageCounts,
  messageDeletion,
  messageDownload,
  messageEvent,
  messageLink,
  messageLinks,
  messagePin,
  messageStar,
  messageSync,
  messageTranscript,
  messageWrite,
  model,
  modelKey,
  note,
  officialStats,
  organization,
  person,
  place,
  poll,
  pollChange,
  pollVote,
  project,
  ranking,
  reaction,
  reactionChange,
  recipient,
  recipientAdded,
  recipientChange,
  recipientOff,
  recipientRemoved,
  recordedRun,
  reference,
  relationship,
  reminder,
  removedModelKey,
  retention,
  runDetails,
  runHit,
  runLocation,
  savedSearch,
  scheduledJob,
  searchHistoryClear,
  sendAttempt,
  serveSummary,
  stickerInventory,
  storeBackup,
  storeChatStatus,
  storeCheck,
  storeClear,
  storeCopyRemoval,
  storeDecrypt,
  storedModelKey,
  storeExport,
  storeGapPlan,
  storeGapRepair,
  storeInfo,
  storeJobCancel,
  storeJobClear,
  storeJobDetails,
  storeJobRetry,
  storeMigration,
  storeReindex,
  storeRepair,
  storeReset,
  storeRestore,
  storeTable,
  tagChange,
  tagging,
  task,
  taskCard,
  taskCategories,
  taskClosed,
  taskCreated,
  taskLinks,
  taskMerge,
  taskPair,
  taskScan,
  taskSimilar,
  taskStats,
  taskUnmerge,
  topic,
  trackedChat,
  trackedChatHistory,
  watchedMessage,
  watchItem,
}

export const ENTITIES = {
  sync_progress: syncProgress,
  ...MEETING_RESULT_ENTITIES,
  message,
  message_context: messageContext,
  message_download: messageDownload,
  message_sync: messageSync,
  "message.hit": v.strictObject({
    ...v.pick(message, [
      "ref",
      "chat_title",
      "timestamp",
      "sender_name",
      "sender_is_me",
      "excerpt",
      "matched_in",
      "score",
      "match",
      "corrections",
      "found_in",
      "discovery",
      "context",
      "follow_ups",
      "email",
    ]).entries,
    untrusted,
  }),
  "message.summary": v.pick(message, [
    "ref",
    "chat_id",
    "chat_title",
    "timestamp",
    "sender_name",
    "sender_is_me",
    "outgoing",
    "text",
    "transcript",
    "attachments",
  ]),
  message_link: messageLink,
  message_write: messageWrite,
  message_send: messageSend,
  message_pin: messagePin,
  message_star: messageStar,
  message_deletion: messageDeletion,
  message_transcript: messageTranscript,
  message_links: messageLinks,
  evidence_packet: evidencePacket,
  chat_metadata: cachedChatMetadata,
  chat_metadata_refresh: chatMetadataRefresh,
  chat,
  mention,
  "mention.details": mentionDetails,
  mention_domain: mentionDomain,
  mention_decision: mentionDecision,
  mention_rebuild: mentionRebuild,
  place,
  person,
  identity,
  contact_context: contactContext,
  contact_preparation: contactPreparation,
  contact_activity: contactActivity,
  contact_check: contactCheck,
  linked_person: linkedPerson,
  contact,
  contact_note: contactNote,
  contact_lookup: contactLookup,
  contact_sync: contactSync,
  contact_update: contactUpdate,
  contact_state_change: contactStateChange,
  contact_import: contactImport,
  contact_alias: contactAlias,
  contact_note_removal: contactNoteRemoval,
  account,
  account_session: accountSession,
  account_change: accountChange,
  ended_account_sessions: endedAccountSessions,
  account_privacy: accountPrivacy,
  account_privacy_change: accountPrivacyChange,
  account_profile: accountProfile,
  organization,
  project,
  reminder,
  bot_profile: botProfile,
  bot_template: botTemplate,
  bot_seen_chat: botSeenChat,
  bot_admin: botAdmin,
  bot_menu_entry: botMenuEntry,
  bot_webhook: botWebhook,
  scheduled_job: scheduledJob,
  call_record: callRecord,
  sticker_inventory: stickerInventory,
  note,
  "note.hit": v.strictObject({
    ...v.pick(note, [
      "kind",
      "provider",
      "account",
      "url",
      "ref",
      "source",
      "folder_id",
      "path",
      "title",
      "updated_at",
      "excerpt",
      "found_by",
      "links",
    ]).entries,
    untrusted,
  }),
  hit,
  document,
  document_link: documentLink,
  image_embedding: imageEmbedding,
  attachment,
  attachment_bytes: attachmentBytes,
  attachment_extraction: attachmentExtraction,
  attachment_text_change: attachmentTextChange,
  media_archive: mediaArchive,
  media_archive_check: mediaArchiveCheck,
  media_archive_move: mediaArchiveMove,
  media_archive_timer: mediaArchiveTimer,
  task,
  task_pair: taskPair,
  task_card: taskCard,
  task_created: taskCreated,
  task_closed: taskClosed,
  task_links: taskLinks,
  task_similar: taskSimilar,
  task_merge: taskMerge,
  task_unmerge: taskUnmerge,
  task_categories: taskCategories,
  task_scan: taskScan,
  fact,
  memory,
  meeting,
  meeting_details: meetingDetails,
  meeting_hit: meetingHit,
  meeting_series_inventory: meetingSeriesInventory,
  meeting_project_candidates: meetingProjectCandidates,
  meeting_project_evidence: meetingProjectEvidence,
  meeting_preparation: meetingPreparation,
  meeting_findings: meetingFindings,
  meeting_transcript: meetingTranscript,
  meeting_summary: meetingSummary,
  meeting_evidence: meetingEvidence,
  meeting_person_context: meetingPersonContext,
  event,
  meeting_review: meetingReview,
  meeting_link: meetingLink,
  meeting_stats: meetingStats,
  meeting_speaker: meetingSpeaker,
  meeting_participants: meetingParticipants,
  meeting_passage: meetingPassage,
  meeting_task_proposal: meetingTaskProposal,
  reference,
  relationship,
  recipient,
  recipient_change: recipientChange,
  "recipient_change.added": recipientAdded,
  "recipient_change.removed": recipientRemoved,
  "recipient_change.off": recipientOff,
  run: recordedRun,
  "run.details": runDetails,
  "run.hit": runHit,
  run_location: runLocation,
  tag_change: tagChange,
  automatic_tags: automaticTags,
  send_attempt: sendAttempt,
  tagging,
  "conversation.details": conversationDetails,
  conversation_build: conversationBuildResult,
  conversation_batch_status: conversationBatchStatus,
  conversation_batch: conversationBatch,
  conversation_change: conversationChange,
  conversation_readiness: conversationReadiness,
  conversation_embedding: conversationEmbedding,
  conversation_embedding_status: conversationEmbeddingStatus,
  conversation_preparation: conversationPreparation,
  conversation_hit: conversationHit,
  conversation,
  saved_search: savedSearch,
  search_history_clear: searchHistoryClear,
  watch_item: watchItem,
  serve_summary: serveSummary,
  job,
  store_chat_status: storeChatStatus,
  store_clear: storeClear,
  store_export: storeExport,
  store_gap_plan: storeGapPlan,
  store_gap_repair: storeGapRepair,
  store_job_details: storeJobDetails,
  store_job_cancel: storeJobCancel,
  store_job_retry: storeJobRetry,
  store_job_clear: storeJobClear,
  store_info: storeInfo,
  store_check: storeCheck,
  store_migration: storeMigration,
  store_reindex: storeReindex,
  store_backup: storeBackup,
  store_decrypt: storeDecrypt,
  store_restore: storeRestore,
  store_reset: storeReset,
  store_repair: storeRepair,
  store_copy_removal: storeCopyRemoval,
  store_table: storeTable,
  agenda,
  model,
  chat_group_change: chatGroupChange,
  chat_inspection: chatInspection,
  chat_sender: chatSender,
  chat_read: chatRead,
  chat_members_fetch: chatMembersFetch,
  chat_members_change: chatMembersChange,
  chat_invite: chatInvite,
  chat_invite_change: chatInviteChange,
  chat_request_change: chatRequestChange,
  chat_admin_change: chatAdminChange,
  chat_folder_change: chatFolderChange,
  chat_folder_removal: chatFolderRemoval,
  chat_folder_order: chatFolderOrder,
  chat_rules: chatRules,
  chat_moderation: chatModeration,
  model_key: modelKey,
  "model_key.stored": storedModelKey,
  "model_key.removed": removedModelKey,
  chat_event: chatEvent,
  chat_removal: chatRemoval,
  chat_muting: chatMuting,
  chat_archive: chatArchive,
  chat_pin: chatPin,
  chat_unread: chatUnread,
  invite_link: inviteLink,
  join_request: joinRequest,
  member,
  poll: poll,
  poll_change: pollChange,
  poll_vote: pollVote,
  reaction,
  reaction_change: reactionChange,
  topic,
  folder,
  message_counts: messageCounts,
  ranking,
  admin_report: adminReport,
  analysis_consent: analysisConsent,
  analysis_consent_revocation: analysisConsentRevocation,
  retention,
  evidence,
  counters,
  counter_refresh: counterRefresh,
  official_stats: officialStats,
  chart,
  chat_stats: chatStats,
  tracked_chat: trackedChat,
  tracked_chat_history: trackedChatHistory,
  chat_tracking: chatTracking,
  task_stats: taskStats,
} as const

export type EntityName = keyof typeof ENTITIES

/** Every entity as a JSON Schema 2020-12 `$defs` entry, for bundling into an MCP tool's `outputSchema`. */
export const entityDefinitions = (): Record<EntityName, unknown> =>
  Object.fromEntries(
    Object.entries(ENTITIES).map(([name, schema]) => {
      const { $schema: _, ...definition } = jsonSchemaOf(schema) as Record<string, unknown>
      return [name, definition]
    }),
  ) as Record<EntityName, unknown>

export { zonedTime } from "./fields.js"
export { meetingFindings } from "./meeting-findings.js"
export { meetingPreparation } from "./meeting-preparation.js"
