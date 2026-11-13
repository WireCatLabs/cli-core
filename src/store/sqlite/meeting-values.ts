import type { CallDirection, CallManager, Meeting, Transcript, TranscriptRow } from "../../meetings/index.js"
import type { CacheDatabase } from "../driver.js"
import { fromJson, int, str } from "./events.js"

type Row = Record<string, unknown>

/** The participant a phone-line source marked `manager`, read only for a call. */
const managerOf = (database: CacheDatabase, meetingId: number): CallManager | null => {
  const found = database
    .prepare(
      "SELECT p.display_name, i.name, l.person_id FROM meeting_participants p JOIN identities i ON i.id = p.identity_id " +
        "LEFT JOIN identity_links l ON l.identity_id = p.identity_id WHERE p.meeting_id = ? AND p.role = 'manager' " +
        "ORDER BY p.id LIMIT 1",
    )
    .get(meetingId)
  if (!found) return null
  return {
    name: str(found.display_name) ?? str(found.name),
    person: found.person_id == null ? null : `person:${found.person_id}`,
  }
}

const callOf = (database: CacheDatabase, row: Row): Pick<Meeting, "direction" | "clientPhone" | "manager"> =>
  row.direction == null && row.client_phone == null
    ? {}
    : {
        direction: str(row.direction) as CallDirection | null,
        clientPhone: str(row.client_phone),
        manager: managerOf(database, Number(row.id)),
      }

export const meetingOf = (database: CacheDatabase, row: Row): Meeting => ({
  id: Number(row.id),
  accountId: Number(row.account_id),
  meetingSeriesId: int(row.meeting_series_id),
  eventId: int(row.event_id),
  externalId: String(row.external_id),
  title: str(row.title),
  description: str(row.description),
  location: str(row.location),
  joinUrl: str(row.join_url),
  startedAt: int(row.started_at),
  endedAt: int(row.ended_at),
  durationMs: int(row.duration_ms),
  timezone: str(row.timezone),
  hostIdentityId: int(row.host_identity_id),
  participantsCount: int(row.participants_count),
  metadata: fromJson(row.metadata),
  deletedAt: int(row.deleted_at),
  ...callOf(database, row),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

export const transcriptOf = (row: Row): Transcript => ({
  id: Number(row.id),
  meetingId: Number(row.meeting_id),
  source: String(row.source),
  format: str(row.format),
  language: str(row.language),
  contentHash: str(row.content_hash),
  externalCreatedAt: int(row.external_created_at),
  supersededAt: int(row.superseded_at),
  metadata: fromJson(row.metadata),
  deletedAt: int(row.deleted_at),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

export const transcriptRowOf = (row: Row): TranscriptRow => ({
  id: Number(row.id),
  meetingTranscriptId: Number(row.meeting_transcript_id),
  position: Number(row.position),
  startMs: Number(row.start_ms),
  endMs: Number(row.end_ms),
  speakerParticipantId: int(row.speaker_participant_id),
  speakerName: str(row.speaker_name),
  text: String(row.text),
  normalizedText: str(row.normalized_text),
  metadata: fromJson(row.metadata),
  createdAt: Number(row.created_at),
})
