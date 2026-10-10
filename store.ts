import type {
  Attachment,
  ChatLine,
  Event,
  EventSeries,
  Meeting,
  MeetingSeries,
  Metadata,
  Participant,
  Summary,
  Transcript,
  TranscriptRow,
} from "./model.js"

export type NewRecord<T> = Omit<T, "id" | "createdAt" | "updatedAt">
export interface IdentityInput {
  provider: string
  externalId: string
  name: string | null
  metadata: Metadata
}
export interface ParticipantInput extends Omit<NewRecord<Participant>, "meetingId" | "identityId"> {
  identity: IdentityInput
}
export interface TranscriptRowInput
  extends Omit<NewRecord<TranscriptRow>, "meetingTranscriptId" | "speakerParticipantId"> {
  /** Index in this save's participants; null for absent or ambiguous speakers. */
  speakerParticipantPosition: number | null
}
export interface TranscriptInput extends Omit<NewRecord<Transcript>, "meetingId" | "supersededAt"> {
  rows: TranscriptRowInput[]
}
export interface ChatInput extends Omit<NewRecord<ChatLine>, "meetingId" | "senderParticipantId"> {
  senderParticipantPosition: number | null
}
export interface MeetingInput extends Omit<NewRecord<Meeting>, "meetingSeriesId" | "eventId"> {
  series?: Omit<NewRecord<MeetingSeries>, "accountId" | "eventSeriesId">
}
export interface MeetingSave {
  meeting: MeetingInput
  participants?: ParticipantInput[]
  transcripts?: TranscriptInput[]
  chat?: ChatInput[]
  summaries?: Omit<NewRecord<Summary>, "meetingId">[]
  attachments?: Omit<NewRecord<Attachment>, "attachableType" | "attachableId">[]
  now: number
}
export interface MeetingDetails {
  meeting: Meeting
  series: MeetingSeries | null
  participants: Participant[]
  transcripts: { transcript: Transcript; rows: TranscriptRow[] }[]
  chat: ChatLine[]
  summaries: Summary[]
  attachments: Attachment[]
}
export interface MeetingFilter {
  accountId?: number
  eventId?: number
  meetingSeriesId?: number
  since?: number
  until?: number
  includeDeleted?: boolean
  limit?: number
  offset?: number
}
export interface EventCandidateFilter {
  meetingSeriesId: number | null
  joinUrl: string | null
  startsAt: number
  endsAt: number
}
export interface SearchHit {
  meetingId: number
  scope: "transcript" | "chat" | "summary"
  id: number
  text: string
  startMs: number | null
}
export interface ContractCase {
  name: string
  run(): Promise<void>
}

/** Missing parts are unknown, never a request to delete previously saved data. */
export interface MeetingStore {
  /** Atomic, keyed by account + external id. Preserves event links and transcript history. */
  saveMeeting(input: MeetingSave): Promise<MeetingDetails>
  meetings(filter?: MeetingFilter): Promise<Meeting[]>
  meeting(id: number): Promise<MeetingDetails | null>
  participants(query: string, accountId?: number): Promise<Participant[]>
  search(query: string, filter?: MeetingFilter): Promise<SearchHit[]>
  events(): Promise<Event[]>
  eventCandidates(filter: EventCandidateFilter): Promise<Event[]>
  createEvent(input: NewRecord<Event>, now: number): Promise<Event>
  createEventSeries(input: NewRecord<EventSeries>, now: number): Promise<EventSeries>
  setEventSeries(meetingSeriesId: number, eventSeriesId: number, now: number): Promise<void>
  /** Automatic linking must not replace an existing link. */
  linkMeeting(id: number, eventId: number, now: number, mode?: "auto" | "owner"): Promise<void>
  cursor(accountId: number): Promise<string | null>
  setCursor(accountId: number, value: string, now: number): Promise<void>
}
