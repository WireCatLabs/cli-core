import type { Event } from "./model.js"

/** One calendar as a provider lists it. */
export interface CalendarInput {
  externalId: string
  title: string | null
  timezone: string | null
  /** owner, writer, reader, freeBusyReader. A calendar the owner owns syncs by default. */
  accessRole: string | null
  primary: boolean
}

export interface StoredCalendar {
  id: number
  accountId: number
  externalId: string
  title: string | null
  timezone: string | null
  accessRole: string | null
  primary: boolean
  synced: boolean
  seenAt: number | null
  deletedAt: number | null
}

export interface EntryParticipantInput {
  email: string
  name?: string | null
  response?: string | null
  optional?: boolean
  organizer?: boolean
  self?: boolean
  /** A room or a piece of equipment: listed, never a contact. */
  resource?: boolean
}

export type EntryKind = "single" | "series" | "occurrence"
export type EntryStatus = "confirmed" | "tentative" | "cancelled"

/**
 * One calendar entry as the provider returns it. Times are epoch milliseconds, `endsAt` exclusive. Text is cleaned
 * before it is stored; there is no field for a conference's entry points, so no passcode or PIN can be given.
 */
export interface EntryInput {
  externalId: string
  kind: EntryKind
  /** An occurrence's series, by the series entry's `externalId` (Google's `recurringEventId`). */
  seriesExternalId?: string | null
  icalUid?: string | null
  /** An occurrence's slot in its series (Google's `originalStartTime`). */
  originalStartsAt?: number | null
  exception?: boolean
  status: EntryStatus
  title?: string | null
  description?: string | null
  location?: string | null
  startsAt?: number | null
  endsAt?: number | null
  allDay?: boolean
  startDate?: string | null
  endDate?: string | null
  timezone?: string | null
  recurrence?: string[] | null
  /** A series' last slot; `null` repeats indefinitely. */
  recurrenceEndsAt?: number | null
  eventType?: string | null
  transparency?: string | null
  visibility?: string | null
  ownResponse?: string | null
  organizer?: { email: string; name?: string | null } | null
  participants?: EntryParticipantInput[]
  joinUrl?: string | null
  conference?: string | null
  url?: string | null
  sequence?: number | null
  etag?: string | null
  externalUpdatedAt?: number | null
  /** Only the keys `ENTRY_METADATA_KEYS` names are kept. */
  metadata?: Record<string, unknown> | null
}

export interface StoredEntry {
  id: number
  calendarId: number
  kind: EntryKind
  seriesEntryId: number | null
  eventId: number | null
  eventSeriesId: number | null
  externalId: string
  icalUid: string | null
  originalStartsAt: number | null
  exception: boolean
  status: EntryStatus
  title: string | null
  description: string | null
  location: string | null
  startsAt: number | null
  endsAt: number | null
  allDay: boolean
  startDate: string | null
  endDate: string | null
  timezone: string | null
  recurrence: string[] | null
  recurrenceEndsAt: number | null
  eventType: string | null
  ownResponse: string | null
  organizerIdentityId: number | null
  joinUrl: string | null
  joinKey: string | null
  url: string | null
  externalUpdatedAt: number | null
  seenAt: number | null
  deletedAt: number | null
}

export interface StoredParticipant {
  entryId: number
  identityId: number | null
  email: string
  name: string | null
  response: string | null
  optional: boolean
  organizer: boolean
  self: boolean
  resource: boolean
}

/** An entry's tracked fields as they were before one change. */
export interface EntryRevision {
  entryId: number
  title: string | null
  startsAt: number | null
  endsAt: number | null
  location: string | null
  status: string | null
  recurrence: string[] | null
  recurrenceEndsAt: number | null
  externalUpdatedAt: number | null
  createdAt: number
}

export interface EventDetails {
  event: Event
  entries: StoredEntry[]
  participants: StoredParticipant[]
  revisions: EntryRevision[]
}

export interface EventFilter {
  /** Events that end after this instant (exclusive end). */
  from?: number
  /** Events that start before this instant. */
  to?: number
  accountId?: number
  calendarId?: number
  /** Events whose entries list one of this person's contacts. */
  personId?: number
  /** Latest start first; earliest first when absent. */
  newest?: boolean
  limit?: number
  offset?: number
}

/** Pairs the rules left unlinked because two or more entities fit equally well (requirements 3.6). */
export interface LinkReview {
  id: number
  linkableType: string
  linkableId: number
  entityType: string
  candidates: number[]
  reason: string
  status: "open" | "linked" | "apart"
  chosenId: number | null
  decidedBy: string | null
  decidedAt: number | null
  createdAt: number
}

export type ReviewDecision = { choose: number } | { apart: true }

/**
 * Calendars and their entries, the source records of events (requirements 3.4). Apart from `MeetingStore`: a
 * calendar CLI implements this one, a meeting app the other. Every write is one transaction; an owner's link is never
 * replaced by a rule, and two equally good candidates make no link and one review entry.
 */
export interface EventStore {
  saveCalendars(accountId: number, calendars: CalendarInput[], now: number): Promise<StoredCalendar[]>
  calendars(accountId: number): Promise<StoredCalendar[]>
  setCalendarSynced(calendarId: number, synced: boolean, now: number): Promise<void>
  /** One sync page, matched by rules 1–5, in one transaction. */
  saveEntries(calendarId: number, entries: EntryInput[], now: number): Promise<StoredEntry[]>
  /**
   * After a full list (`410 Gone`): entries not seen since `seenBefore` get `deleted_at`. Plain occurrences come only
   * from the window fetched, so only those inside it count. Events, series and links stay.
   */
  markUnseen(calendarId: number, seenBefore: number, window: { from: number; to: number }, now: number): Promise<number>
  events(filter?: EventFilter): Promise<Event[]>
  event(id: number): Promise<EventDetails | null>
  /** The owner's link of an entry to an event; no rule replaces it. */
  linkEntry(entryId: number, eventId: number, now: number): Promise<void>
  /** The owner's unlink: the rules leave the entry alone after it. */
  unlinkEntry(entryId: number, now: number): Promise<void>
  reviews(filter?: { status?: LinkReview["status"] }): Promise<LinkReview[]>
  resolveReview(id: number, decision: ReviewDecision, now: number): Promise<LinkReview>
}
