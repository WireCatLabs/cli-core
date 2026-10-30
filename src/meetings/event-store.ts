import type { Event } from "./model.js"

/*
 * Calendar words are stored in one neutral spelling, RFC 5545 where it has one, lower case with hyphens. Each
 * adapter translates its provider's words; a provider's own spelling never reaches a column.
 */

/** RFC 5545 PARTSTAT: a participant's answer, and the owner's own. */
export type ParticipantResponse = "needs-action" | "accepted" | "tentative" | "declined" | "delegated"
/** What kind of entry it is. Only `default` and `from-mail` are searched (requirements 3.4). */
export type EntryEventType = "default" | "out-of-office" | "focus" | "working-location" | "birthday" | "from-mail"
/** RFC 5545 TRANSP. */
export type EntryTransparency = "opaque" | "transparent"
/** RFC 5545 CLASS, plus `default`: the calendar's own setting. */
export type EntryVisibility = "default" | "public" | "private" | "confidential"
/** What the owner may do with a calendar: `free-busy` sees only busy slots. */
export type CalendarAccessRole = "owner" | "writer" | "reader" | "free-busy"

/** One calendar as a provider lists it. */
export interface CalendarInput {
  externalId: string
  title: string | null
  timezone: string | null
  accessRole: CalendarAccessRole | null
  primary: boolean
  /** Whether a calendar seen for the first time syncs; the adapter decides. Later lists leave `synced` alone. */
  syncByDefault: boolean
}

export interface StoredCalendar {
  id: number
  accountId: number
  externalId: string
  title: string | null
  timezone: string | null
  accessRole: CalendarAccessRole | null
  primary: boolean
  synced: boolean
  seenAt: number | null
  deletedAt: number | null
}

export interface EntryParticipantInput {
  email: string
  name?: string | null
  response?: ParticipantResponse | null
  optional?: boolean
  organizer?: boolean
  self?: boolean
  /** A room or a piece of equipment: listed, never a contact. */
  resource?: boolean
}

/** A Google Drive file attached to a calendar entry (Google's `attachments[]`). */
export interface EntryAttachmentInput {
  /** The Drive file's id: `files.external_id` of a stored Drive file. */
  fileId: string
  title?: string | null
}

/** A Drive file attached to an entry, and the document it is once Drive has stored it. */
export interface EntryAttachment {
  entryId: number
  fileId: string
  title: string | null
  /** `null` while no Drive account holds the file, while two do, or while its document is deleted. */
  documentId: number | null
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
  /** An occurrence's series, by the series entry's `externalId`. */
  seriesExternalId?: string | null
  /** The RFC 5545 UID of the series: the same on the series and every occurrence, and across calendars. */
  icalUid?: string | null
  /** An occurrence's slot in its series, as first scheduled; an all-day slot is midnight UTC of its date. */
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
  eventType?: EntryEventType | null
  transparency?: EntryTransparency | null
  visibility?: EntryVisibility | null
  ownResponse?: ParticipantResponse | null
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
  /**
   * Its Drive files: each links the entry to the file's document, now or once Drive stores the file. Absent keeps the
   * links the entry has; a list replaces them. Google leaves `attachments` out of an event that has none, so a provider
   * sending a whole event sends `[]` then, or a file removed from the event stays linked.
   */
  attachments?: EntryAttachmentInput[]
}

export interface StoredEntry {
  id: number
  calendarId: number
  kind: EntryKind
  seriesEntryId: number | null
  /** On an occurrence: its series' `externalId`, also before that series is stored. */
  seriesExternalId: string | null
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
  eventType: EntryEventType | null
  ownResponse: ParticipantResponse | null
  organizerIdentityId: number | null
  joinUrl: string | null
  joinKey: string | null
  url: string | null
  externalUpdatedAt: number | null
  /** The provider's version of the entry, sent back with a write so a change made since the last sync is refused. */
  etag: string | null
  seenAt: number | null
  deletedAt: number | null
}

export interface StoredParticipant {
  entryId: number
  identityId: number | null
  email: string
  name: string | null
  response: ParticipantResponse | null
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
  attachments: EntryAttachment[]
}

export interface EventFilter {
  /** Events that end after this instant (exclusive end). */
  from?: number
  /** Events that start before this instant. */
  to?: number
  /** All-day events, which have dates and no instant, ending after this local day (`YYYY-MM-DD`); `from` without it. */
  fromDate?: string
  /** All-day events starting before this local day (exclusive); `to` without it. */
  toDate?: string
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
  /** The calendar of a `calendar_entry` review's copy, so a choice is made only from that calendar's account. */
  calendarId: number | null
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
   * Entries the provider confirmed deleted and names only by id, cancelled as a cancelled entry would be: past events
   * stay as history, future ones cancel, a series cancels its occurrences. Unknown ids are skipped; the count is of
   * entries cancelled now.
   */
  removeEntries(calendarId: number, externalIds: string[], now: number): Promise<number>
  /**
   * After a full list: entries not seen since `seenBefore` get `deleted_at`. A full list holds only what falls in the
   * window, so only entries `entryInWindow` puts there count. Events, series and links stay.
   */
  markUnseen(calendarId: number, seenBefore: number, window: { from: number; to: number }, now: number): Promise<number>
  /**
   * Takes `deleted_at` off the entries a full list marked although they were outside the window it listed:
   * `windowAt(deletedAt)` is the window of the list that marked one. Their events take their fields again. Returns how
   * many came back.
   */
  restoreUnseen(
    calendarId: number,
    windowAt: (deletedAt: number) => { from: number; to: number },
    now: number,
  ): Promise<number>
  /**
   * Where the calendar's last sync stopped, as the sync engine wrote it (`{"v":1,"token":…,"window":…,"fullAt":…}`),
   * or `null` before the first one.
   */
  cursor(calendarId: number): Promise<string | null>
  /** `null` forgets the cursor, so the next sync is a full list. */
  setCursor(calendarId: number, value: string | null, now: number): Promise<void>
  /** One entry by the provider's id; a series, which no event holds, is found only this way. */
  entry(calendarId: number, externalId: string): Promise<StoredEntry | null>
  /** The series' stored slots, moved ones too, whose original start falls in the window; deleted ones left out. */
  slotsOf(calendarId: number, seriesExternalId: string, window: { from: number; to: number }): Promise<StoredEntry[]>
  events(filter?: EventFilter): Promise<Event[]>
  event(id: number): Promise<EventDetails | null>
  /** The owner's link of an entry to an event; no rule replaces it. */
  linkEntry(entryId: number, eventId: number, now: number): Promise<void>
  /** The owner's unlink: the rules leave the entry alone after it. */
  unlinkEntry(entryId: number, now: number): Promise<void>
  reviews(filter?: { status?: LinkReview["status"] }): Promise<LinkReview[]>
  resolveReview(id: number, decision: ReviewDecision, now: number): Promise<LinkReview>
}

const UNTIL = /(?:^|;)UNTIL=(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?(?:;|$)/iu

/** The last moment a series can have a slot, when its rule says; a COUNT rule or none repeats as far as this knows. */
const seriesEnd = (entry: Pick<StoredEntry, "recurrence" | "recurrenceEndsAt">): number => {
  if (entry.recurrenceEndsAt !== null) return entry.recurrenceEndsAt
  const rule = entry.recurrence?.find((line) => /^RRULE:/iu.test(line))
  const until = rule === undefined ? null : UNTIL.exec(rule.slice("RRULE:".length))
  if (!until) return Number.POSITIVE_INFINITY
  const [, year, month, day, hour = "23", minute = "59", second = "59"] = until
  // A floating or zoned UNTIL is read as UTC; a day later keeps a series near the edge counted as inside.
  return (
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) + 86_400_000
  )
}

/**
 * Whether a full list of the window would return the entry: a single or a moved slot by its own time, a plain slot by
 * the time its series gave it, a series while it repeats into the window. An entry with no time is never counted.
 */
export const entryInWindow = (
  entry: Pick<
    StoredEntry,
    "kind" | "exception" | "startsAt" | "endsAt" | "originalStartsAt" | "recurrence" | "recurrenceEndsAt"
  >,
  window: { from: number; to: number },
): boolean => {
  if (entry.kind === "occurrence" && !entry.exception)
    return (
      entry.originalStartsAt !== null && entry.originalStartsAt >= window.from && entry.originalStartsAt < window.to
    )
  const start = entry.startsAt ?? (entry.kind === "occurrence" ? entry.originalStartsAt : null)
  if (start === null || start >= window.to) return false
  if (entry.kind === "series") return seriesEnd(entry) >= window.from
  return Math.max(entry.endsAt ?? start, start + 1) > window.from
}
