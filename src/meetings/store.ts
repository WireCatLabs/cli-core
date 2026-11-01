import type { QueryAst } from "@wirecat/cli-base/query"
import type { MeetingOwner } from "./item.js"
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
  /** Explicit stable provider key; false or absent must not create a person association. */
  associatePerson?: boolean
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
export interface MeetingInput extends Omit<NewRecord<Meeting>, "meetingSeriesId" | "eventId" | "participantsCount"> {
  /** Left out when the participants could not be read, so the stored count stays. */
  participantsCount?: number | null
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
  /**
   * A copy of the occurrence read from a file, not from the provider. It joins the provider's record of the same
   * occurrence — same series, start within 15 minutes — and only fills a missing transcript there; a provider
   * record saved later takes over a record made from files. Transcripts from files have source `file`.
   */
  fromFile?: boolean
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
  /** A validated `meetings list` query over `MEETING_QUERY`'s fields. */
  query?: QueryAst
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
export interface MeetingHitSource {
  title: string | null
  startedAt: number | null
  /** A stored source-document permalink, never a meeting join or signed download URL. */
  url: string | null
}

export interface SearchHit {
  source?: MeetingHitSource
  /** A retained cue reference for transcript hits, or the parent meeting for other sources. */
  ref?: string
  meetingId: number
  scope: "transcript" | "chat" | "summary"
  id: number
  text: string
  startMs: number | null
  /** Who spoke a transcript hit's cue, as the transcript names them; absent for chat and summary hits. */
  speakerName?: string | null
  /** `corrected` when a query word matched only as a stored word recognition may have garbled. */
  match?: "words" | "corrected"
  /** For a `corrected` hit, the stored words each such query word matched in this passage. */
  corrections?: { from: string; to: string[] }[]
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
  /** The provider and account a meeting account id stands for; `null` when the store has no such account. */
  account(id: number): Promise<MeetingOwner | null>
  meeting(id: number): Promise<MeetingDetails | null>
  participants(query: string, accountId?: number): Promise<Participant[]>
  search(query: string, filter?: MeetingFilter): Promise<SearchHit[]>
  events(): Promise<Event[]>
  /** Filters at the store; adapters without this method refuse nonempty event queries. */
  queryEvents?(query: QueryAst): Promise<Event[]>
  /** Inclusive overlap; an event with a start but no end occupies its start instant. */
  eventCandidates(filter: EventCandidateFilter): Promise<Event[]>
  createEvent(input: NewRecord<Event>, now: number): Promise<Event>
  createEventSeries(input: NewRecord<EventSeries>, now: number): Promise<EventSeries>
  setEventSeries(meetingSeriesId: number, eventSeriesId: number, now: number): Promise<void>
  /** Automatic linking must not replace an existing link. */
  linkMeeting(id: number, eventId: number, now: number, mode?: "auto" | "owner"): Promise<void>
  /** Two or more events fit a meeting equally: no link, and the pair goes to the owner's review list. */
  reviewMeetingLink?(meetingId: number, eventIds: number[], now: number): Promise<void>
  cursor(accountId: number): Promise<string | null>
  setCursor(accountId: number, value: string, now: number): Promise<void>
}
