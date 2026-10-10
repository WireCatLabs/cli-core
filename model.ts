export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type Metadata = { [key: string]: JsonValue } | null

/** Store ids are integers; all timestamps are epoch milliseconds. */
export interface RecordTimes {
  createdAt: number
  updatedAt: number
}

export interface EventSeries extends RecordTimes {
  id: number
  title: string | null
  recurrence: string | null
  origin: "auto" | "owner"
}

export interface Event extends RecordTimes {
  id: number
  eventSeriesId: number | null
  title: string | null
  description: string | null
  location: string | null
  startsAt: number | null
  endsAt: number | null
  timezone: string | null
  origin: "auto" | "owner"
  deletedAt: number | null
}

export interface MeetingSeries extends RecordTimes {
  id: number
  accountId: number
  externalId: string
  eventSeriesId: number | null
  title: string | null
  description: string | null
  kind: string | null
  recurrence: JsonValue
  hostIdentityId: number | null
  joinUrl: string | null
  metadata: Metadata
  deletedAt: number | null
}

export interface Meeting extends RecordTimes {
  id: number
  accountId: number
  meetingSeriesId: number | null
  eventId: number | null
  externalId: string
  title: string | null
  description: string | null
  location: string | null
  joinUrl: string | null
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
  timezone: string | null
  hostIdentityId: number | null
  participantsCount: number | null
  metadata: Metadata
  deletedAt: number | null
}

export interface Participant extends RecordTimes {
  id: number
  meetingId: number
  identityId: number
  displayName: string | null
  email: string | null
  role: string | null
  joinedAt: number | null
  leftAt: number | null
  durationMs: number | null
  sessions: JsonValue
  externalId: string | null
  metadata: Metadata
}

export interface Transcript extends RecordTimes {
  id: number
  meetingId: number
  source: string
  format: string | null
  language: string | null
  contentHash: string | null
  externalCreatedAt: number | null
  supersededAt: number | null
  metadata: Metadata
  deletedAt: number | null
}

export interface TranscriptRow {
  id: number
  meetingTranscriptId: number
  position: number
  startMs: number
  endMs: number
  speakerParticipantId: number | null
  speakerName: string | null
  text: string
  normalizedText: string | null
  metadata: Metadata
  createdAt: number
}

export interface ChatLine extends RecordTimes {
  id: number
  meetingId: number
  externalId: string | null
  sentAt: number
  senderParticipantId: number | null
  senderName: string | null
  recipient: string | null
  text: string
  normalizedText: string | null
  metadata: Metadata
}

export interface SummaryContent {
  title: string | null
  overview: string | null
  sections: { label: string; text: string }[]
  nextSteps: string[]
}

export interface Summary extends RecordTimes, SummaryContent {
  id: number
  meetingId: number
  source: string
  content: string | null
  docUrl: string | null
  externalCreatedAt: number | null
  externalUpdatedAt: number | null
  metadata: Metadata
}

/** Meeting files use the shared polymorphic attachments table. */
export interface Attachment extends RecordTimes {
  id: number
  attachableType: "meeting"
  attachableId: number
  position: number
  kind: string
  mime: string | null
  name: string | null
  title: string | null
  url: string | null
  size: number | null
  width: number | null
  height: number | null
  duration: number | null
  providerRef: JsonValue
  localPath: string | null
  text: string | null
  normalizedText: string | null
  extraction: string | null
  extractor: string | null
  extractionError: string | null
  contentSha256: string | null
  extractedAt: number | null
}

/** Unstored WebVTT cue; its position is assigned when saving a transcript. */
export interface TranscriptLine {
  startMs: number
  endMs: number
  speaker: string | null
  text: string
}

export interface Occurrence {
  id: string
  seriesId: string
  title: string | null
  startedAt: string
  endedAt: string | null
}

export interface SourceMeeting {
  description?: string | null
  location?: string | null
  joinUrl?: string | null
  timezone?: string | null
  metadata?: Metadata
  series: {
    id: string
    provider: string
    title: string | null
    kind?: string
    recurrence?: JsonValue
    joinUrl?: string
  } | null
  occurrence: Occurrence
}

export interface SourceChatLine {
  sentAt: string
  sender: string | null
  text: string
}
