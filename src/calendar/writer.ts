import { CliError } from "@wirecat/cli-base"
import type { EntryInput, ParticipantResponse, StoredCalendar } from "../meetings/index.js"
import type { Level, PermissionKey } from "../sends/permissions.js"

/**
 * A new event in neutral words: a timed one has `startsAt` and `endsAt` (epoch ms, end exclusive) in `timezone`; an
 * all-day one has `startDate` and `endDate` (`YYYY-MM-DD`, end exclusive). Never repeating.
 */
export interface EventDraft {
  title: string
  startsAt?: number
  endsAt?: number
  startDate?: string
  endDate?: string
  timezone?: string | null
  location?: string | null
  description?: string | null
  attendees?: { email: string; optional?: boolean }[]
}

/** Only the fields to change; `null` clears one. `attendees` replaces the whole list. */
export type EventPatch = Partial<EventDraft>

/** `this`: the one entry named; `series`: the repeating event it belongs to, named by the series' own id. */
export type WriteScope = "this" | "series"

export type EventResponse = Extract<ParticipantResponse, "accepted" | "tentative" | "declined">

/**
 * Writes to one provider's calendars. Each change carries the entry's `etag`, sent as the provider's precondition
 * (Google and CalDAV `If-Match`); a mismatch throws `calendarConflict()`, never overwrites. `notify` says whether the
 * provider mails the other attendees.
 */
export interface CalendarWriter {
  readonly provider: string
  /**
   * `id` is chosen here and journaled before the call: a create with an id the provider already holds returns that
   * event instead of making a second one, so a retry after `outcome_unknown` is safe.
   */
  create(calendar: StoredCalendar, draft: EventDraft, options: { id: string; notify: boolean }): Promise<EntryInput>
  update(
    calendar: StoredCalendar,
    externalId: string,
    patch: EventPatch,
    options: { scope: WriteScope; etag: string; notify: boolean },
  ): Promise<EntryInput>
  /** Nothing comes back from a deletion; the store cancels the entry as a sync would. */
  remove(
    calendar: StoredCalendar,
    externalId: string,
    options: { scope: WriteScope; etag: string; notify: boolean },
  ): Promise<void>
  respond(
    calendar: StoredCalendar,
    externalId: string,
    response: EventResponse,
    options: { etag: string; notify: boolean },
  ): Promise<EntryInput>
}

/** Which write a command makes, for `CalendarWrites.extraKeys`. */
export type CalendarWrite = "create" | "update" | "delete" | "respond"

/** Mailing the other attendees: an agent may write to the calendar and still not to people (WC-PERM-14's spirit). */
export const EVENTS_NOTIFY_KEY: PermissionKey = "events.notify"
export const EVENTS_DELETE_SERIES_KEY: PermissionKey = "events.delete.series"

/** The keys the calendar writes check beyond their command paths, for a CLI's `commandPermissions({ extra })`. */
export const CALENDAR_WRITE_KEYS: readonly PermissionKey[] = [EVENTS_NOTIFY_KEY, EVENTS_DELETE_SERIES_KEY]

/** Built in, and only ever tightening (WC-PERM-7): one change asks, a whole series is not deleted, nobody is mailed. */
export const CALENDAR_WRITE_DEFAULTS: Readonly<Record<PermissionKey, Level>> = {
  "events.create": "ask",
  "events.update": "ask",
  "events.respond": "ask",
  "events.delete": "ask",
  [EVENTS_DELETE_SERIES_KEY]: "deny",
  [EVENTS_NOTIFY_KEY]: "deny",
}

/** What an adapter throws when the provider refused a write because the entry's `etag` is old (HTTP 412). */
export const calendarConflict = (message = "the event changed at the provider since the last sync") =>
  new CliError("validation_error", `${message}; sync and try again`, { reason: "event.conflict" })
