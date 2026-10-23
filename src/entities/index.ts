import { jsonSchemaOf } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { account } from "./account.js"
import { accountSession } from "./account-session.js"
import { adminReport } from "./admin-report.js"
import { agenda } from "./agenda.js"
import { attachment } from "./attachment.js"
import { chart } from "./chart.js"
import { chat } from "./chat.js"
import { chatEvent } from "./chat-event.js"
import { chatStats, taskStats } from "./chat-stats.js"
import { contact } from "./contact.js"
import { contactNote } from "./contact-note.js"
import { contactLookup, contactProfile, contactSync } from "./contact-read.js"
import { conversation } from "./conversation.js"
import { counterRefresh, counters } from "./counters.js"
import { document } from "./document.js"
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
import { messageCounts } from "./message-counts.js"
import { messageLink } from "./message-link.js"
import { model } from "./model.js"
import { note } from "./note.js"
import { officialStats } from "./official-stats.js"
import { person } from "./person.js"
import { pollVote } from "./poll-vote.js"
import { ranking } from "./ranking.js"
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
  accountSession,
  adminReport,
  agenda,
  attachment,
  chart,
  chat,
  chatEvent,
  chatStats,
  contact,
  contactLookup,
  contactNote,
  contactProfile,
  contactSync,
  conversation,
  counterRefresh,
  counters,
  document,
  evidence,
  fact,
  folder,
  hit,
  identity,
  inviteLink,
  job,
  joinRequest,
  meeting,
  meetingProjectCandidates,
  meetingSeriesInventory,
  member,
  memory,
  message,
  messageCounts,
  messageLink,
  model,
  note,
  officialStats,
  person,
  pollVote,
  ranking,
  reference,
  relationship,
  retention,
  savedSearch,
  tagging,
  task,
  taskStats,
  topic,
}

export const ENTITIES = {
  message,
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
  chat,
  person,
  identity,
  contact,
  contact_note: contactNote,
  contact_lookup: contactLookup,
  contact_profile: contactProfile,
  contact_sync: contactSync,
  account,
  account_session: accountSession,
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
  poll_vote: pollVote,
  topic,
  folder,
  message_counts: messageCounts,
  ranking,
  admin_report: adminReport,
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
