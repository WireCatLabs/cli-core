import { jsonSchemaOf } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { account } from "./account.js"
import { accountChange, accountPrivacy, accountPrivacyChange, endedAccountSessions } from "./account-change.js"
import { accountProfile } from "./account-profile.js"
import { accountSession } from "./account-session.js"
import { adminReport } from "./admin-report.js"
import { agenda } from "./agenda.js"
import { analysisConsent, analysisConsentRevocation } from "./analysis-consent.js"
import { attachment } from "./attachment.js"
import { chart } from "./chart.js"
import { chat } from "./chat.js"
import { chatEvent } from "./chat-event.js"
import { chatStats, taskStats } from "./chat-stats.js"
import { contact } from "./contact.js"
import { contactActivity, contactCheck, linkedPerson } from "./contact-activity.js"
import { contactContext, contactPreparation } from "./contact-context.js"
import { contactNote } from "./contact-note.js"
import { contactLookup, contactProfile, contactSync } from "./contact-read.js"
import { contactImport, contactStateChange, contactUpdate } from "./contact-write.js"
import { conversation } from "./conversation.js"
import { counterRefresh, counters } from "./counters.js"
import { document } from "./document.js"
import { documentLink } from "./document-link.js"
import { evidence } from "./evidence.js"
import { fact } from "./fact.js"
import { reference } from "./fields.js"
import { folder } from "./folder.js"
import { hit } from "./hit.js"
import { identity } from "./identity.js"
import { inviteLink } from "./invite-link.js"
import { job } from "./job.js"
import { joinRequest } from "./join-request.js"
import {
  meeting,
  meetingDetails,
  meetingHit,
  meetingProjectEvidence,
  meetingSummary,
  meetingTranscript,
} from "./meeting.js"
import { meetingFindings } from "./meeting-findings.js"
import { meetingPreparation } from "./meeting-preparation.js"
import { meetingProjectCandidates } from "./meeting-project-candidates.js"
import { meetingSeriesInventory } from "./meeting-series-inventory.js"
import { member } from "./member.js"
import { memory } from "./memory.js"
import { message } from "./message.js"
import { messageDeletion, messagePin, messageStar } from "./message-change.js"
import { messageContext } from "./message-context.js"
import { messageCounts } from "./message-counts.js"
import { messageLink } from "./message-link.js"
import { evidencePacket, messageLinks, messageTranscript } from "./message-read.js"
import { messageDownload, messageSync } from "./message-transfer.js"
import { messageWrite } from "./message-write.js"
import { model } from "./model.js"
import { note } from "./note.js"
import { officialStats } from "./official-stats.js"
import { person } from "./person.js"
import { poll, pollChange } from "./poll.js"
import { pollVote } from "./poll-vote.js"
import { contactAlias, contactNoteRemoval } from "./private-contact.js"
import { ranking } from "./ranking.js"
import { reactionChange } from "./reaction-change.js"
import { recipient, recipientAdded, recipientChange, recipientOff, recipientRemoved } from "./recipient.js"
import { recordedRun, runDetails, runHit, runLocation } from "./recorded-run.js"
import { relationship } from "./relationship.js"
import { retention } from "./retention.js"
import { savedSearch } from "./saved-search.js"
import { tagging } from "./tagging.js"
import { task } from "./task.js"
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
  chart,
  chat,
  chatEvent,
  chatStats,
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
  contactProfile,
  contactStateChange,
  contactSync,
  contactUpdate,
  conversation,
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
  inviteLink,
  job,
  joinRequest,
  linkedPerson,
  meeting,
  meetingProjectCandidates,
  meetingSeriesInventory,
  member,
  memory,
  message,
  messageContext,
  messageCounts,
  messageDeletion,
  messageDownload,
  messageLink,
  messageLinks,
  messagePin,
  messageStar,
  messageSync,
  messageTranscript,
  messageWrite,
  model,
  note,
  officialStats,
  person,
  poll,
  pollChange,
  pollVote,
  ranking,
  reactionChange,
  recipient,
  recipientAdded,
  recipientChange,
  recipientOff,
  recipientRemoved,
  recordedRun,
  reference,
  relationship,
  retention,
  runDetails,
  runHit,
  runLocation,
  savedSearch,
  tagging,
  task,
  taskStats,
  topic,
}

export const ENTITIES = {
  message,
  message_context: messageContext,
  message_download: messageDownload,
  message_sync: messageSync,
  "message.hit": v.pick(message, [
    "ref",
    "chat_title",
    "timestamp",
    "sender_name",
    "excerpt",
    "matched_in",
    "score",
    "match",
    "corrections",
    "found_in",
    "discovery",
    "context",
    "email",
  ]),
  "message.summary": v.pick(message, [
    "ref",
    "chat_id",
    "chat_title",
    "timestamp",
    "sender_name",
    "outgoing",
    "text",
    "transcript",
    "attachments",
  ]),
  message_link: messageLink,
  message_write: messageWrite,
  message_pin: messagePin,
  message_star: messageStar,
  message_deletion: messageDeletion,
  message_transcript: messageTranscript,
  message_links: messageLinks,
  evidence_packet: evidencePacket,
  chat,
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
  contact_profile: contactProfile,
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
  note,
  "note.hit": v.pick(note, [
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
  ]),
  hit,
  document,
  document_link: documentLink,
  attachment,
  task,
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
  tagging,
  conversation,
  saved_search: savedSearch,
  job,
  agenda,
  model,
  chat_event: chatEvent,
  invite_link: inviteLink,
  join_request: joinRequest,
  member,
  poll: poll,
  poll_change: pollChange,
  poll_vote: pollVote,
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
