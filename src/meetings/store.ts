import type { QueryAst } from "@wirecat/cli-base/query"
import type { ListResult } from "@wirecat/cli-base/standards"
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
  /** As the source gave it; the store keeps it only when it reads as E.164. */
  phone?: string | null
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
  /**
   * The Drive file the meeting service saved this transcript as (Meet's `docsDestination.document`). Drive may import
   * the same Google Doc, before or after; the store joins the two, so search shows the meeting once.
   */
  driveFileId?: string
}
export const MEETING_DOCUMENT_ROLES = ["transcript", "recording", "notes"] as const
export type MeetingDocumentRole = (typeof MEETING_DOCUMENT_ROLES)[number]
/**
 * A Drive file the meeting service saved for the meeting: its transcript, its recording or its notes (Meet's
 * `docsDestination.document`, `driveDestination.file`, Gemini's notes). Keyed by the Drive file id alone, so the Drive
 * profile that imports the file may differ from the meeting's.
 */
export interface MeetingDocumentInput {
  fileId: string
  role: MeetingDocumentRole
  title?: string | null
}
/** A meeting's Drive file, and the document it is once a Drive account has stored it. */
export interface MeetingDocument {
  fileId: string
  role: MeetingDocumentRole
  title: string | null
  /** `null` while no Drive account holds the file, while two do (CORE-54), or while its document is deleted. */
  documentId: number | null
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
  /** Adds to the documents held and retitles them; one left out stays linked, since the service forgets its files. */
  documents?: MeetingDocumentInput[]
  now: number
  /**
   * A copy of the occurrence read from a file, not from the provider. It joins the provider's record of the same
   * occurrence — same series, start within 15 minutes — and only fills a missing transcript there; a provider
   * record saved later takes over a record made from files. Transcripts from files have source `file`.
   */
  fromFile?: boolean
}
/** A participant with the person their identity is linked to, when the store knows people. */
export interface MeetingParticipant extends Participant {
  person?: { uid: string; name: string | null }
}
export interface MeetingDetails {
  meeting: Meeting
  series: MeetingSeries | null
  participants: MeetingParticipant[]
  transcripts: { transcript: Transcript; rows: TranscriptRow[] }[]
  chat: ChatLine[]
  summaries: Summary[]
  attachments: Attachment[]
  /** Left out by a store that keeps no Drive links. */
  documents?: MeetingDocument[]
}
export interface MeetingFilter {
  accountId?: number
  /** A validated `meetings list` query over `MEETING_QUERY`'s fields. */
  query?: QueryAst
  /** The zone and the instant the query's dates are read in; UTC and the current time without them. */
  timezone?: string
  now?: number
  /** Only these stored meetings, by their store id. */
  ids?: readonly number[]
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

/** `searchHits`' refusal of a page whose stored text passes `maxReadBytes`; a reader may ask for fewer rows. */
export const READ_BUDGET_EXCEEDED = "Meeting search exceeds its stored text byte budget"

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
  /** A transcript hit's transcript language (`ru`, `en`…), `null` when unknown; absent for chat and summary hits. */
  language?: string | null
  /** A transcript hit's line, from 1, of `linesTotal` lines in its transcript: where in the meeting it was said. */
  line?: number
  linesTotal?: number
  /** `corrected` when a query word matched only as a stored word recognition may have garbled. */
  match?: "words" | "corrected"
  /** For a `corrected` hit, the stored words each such query word matched in this passage. */
  corrections?: { from: string; to: string[] }[]
  /** The words of `text` the query's positive terms matched, as the text spells them. */
  matchedWords?: string[]
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
  /** The account's meeting the provider knows by `externalId` (the occurrence id), deleted or not; `null` when none. */
  meetingByExternalId?(accountId: number, externalId: string): Promise<MeetingDetails | null>
  participants(query: string, accountId?: number): Promise<Participant[]>
  search(query: string, filter?: MeetingFilter): Promise<ListResult<SearchHit>>
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
  /** Links the callers a sync saved, by `provider` and identity external id, to the people with their number. */
  linkCallers?(provider: string, externalIds: readonly string[]): Promise<void>
  /** Detects the language of the account's transcripts that have none; stores it only with `apply`. */
  fillTranscriptLanguages?(input: { accountId: number; apply: boolean; now: number }): Promise<TranscriptLanguageFill>
}
export interface TranscriptLanguageFill {
  accountId: number
  applied: boolean
  /** Transcripts that had no language. */
  transcripts: number
  /** How many of them each language was found in; `null` where the text did not show one. */
  languages: { language: string | null; transcripts: number }[]
}
