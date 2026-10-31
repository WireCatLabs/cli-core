import type { CalendarInput, EntryInput, StoredCalendar } from "../meetings/index.js"

/** Epoch milliseconds; `to` exclusive. */
export interface SyncWindow {
  from: number
  to: number
}

export interface CalendarSourceTraits {
  /**
   * `on-request`: the engine asks `occurrences()` for each series (Google `events.instances`).
   * `in-changes`: occurrences arrive in `changes()` (Graph `calendarView/delta`); no extra calls.
   * `local`: the engine expands the RRULE lines with the expander it was given (ICS, CalDAV).
   */
  expands: "on-request" | "in-changes" | "local"
  /** The cursor encodes the window (Graph delta): a new window means a new full round. */
  cursorHoldsWindow: boolean
  /** No incremental cursor: every run is a full list (an ICS feed). */
  fullListOnly: boolean
}

export interface ChangePage {
  entries: EntryInput[]
  /**
   * Entries the provider confirmed deleted, known only by `externalId` (CalDAV 404; Graph `@removed` that a GET by id
   * answered 404). Never an entry that only left the window.
   */
  removed: string[]
  /** More pages in this round. */
  nextPage?: string
  /** On the last page: the cursor for the next run; `null` when the source has none. */
  cursor?: string | null
}

/** `reset`: the cursor is dead (Google 410, Graph `syncStateNotFound`, CalDAV `valid-sync-token`). */
export type ChangeResult = ChangePage | { reset: true }

/**
 * Whose busy times to read: the account's own calendars by the provider's id, and other people by email address
 * (Google and Graph read a person's primary calendar by it).
 */
export interface FreeBusyRequest {
  calendars: string[]
  people: string[]
  window: SyncWindow
}

/** One calendar's or person's taken times, nothing about what takes them; `error` when the provider would not say. */
export interface BusyTimes {
  /** As asked: the calendar's provider id or the person's address. */
  id: string
  busy: SyncWindow[]
  /** The provider's reason (`notFound`, `groupTooBig`): its busy times are unknown, not free. */
  error?: string
}

/** What the provider's own text search found on one calendar: one page, read and never stored. */
export interface SearchPage {
  entries: EntryInput[]
  /** The provider has more matches on this calendar than it returned. */
  more: boolean
}

/** One provider's calendars, as an adapter reads them. The engine never sees a provider word. */
export interface CalendarSource {
  /** The registry name: `google-calendar`, `outlook-calendar`, `caldav`, `ics`. */
  readonly provider: string
  readonly traits: CalendarSourceTraits
  calendars(): Promise<CalendarInput[]>
  /** `cursor: null` asks for a full list of the window. */
  changes(
    calendar: StoredCalendar,
    request: { cursor: string | null; page?: string; window: SyncWindow },
  ): Promise<ChangeResult>
  /** Required when `traits.expands` is `on-request`: the series' slots inside the window. */
  occurrences?(calendar: StoredCalendar, seriesExternalId: string, window: SyncWindow): Promise<EntryInput[]>
  /** When calendars and people are taken, read from the provider and never stored. Absent: no `calendars busy`. */
  freeBusy?(request: FreeBusyRequest): Promise<BusyTimes[]>
  /**
   * The provider's own text search over one calendar, at most `limit` entries; it also finds events outside the sync
   * window. Absent: no `search --backend server`.
   */
  search?(calendar: StoredCalendar, request: { query: string; limit: number }): Promise<SearchPage>
}

/**
 * Core expansion for `expands: "local"`: a series' slots inside the window, as occurrences. A slot its EXDATE lines
 * remove is returned `cancelled`, so a stored slot is cancelled rather than left behind.
 */
export type CalendarExpander = (series: EntryInput, window: SyncWindow) => EntryInput[] | Promise<EntryInput[]>
