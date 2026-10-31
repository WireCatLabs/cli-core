import { CliError } from "@wirecat/cli-base"
import type { EntryInput, ParticipantResponse, StoredCalendar } from "../meetings/index.js"
import type { Level, PermissionKey } from "../sends/permissions.js"

/**
 * A new event in neutral words: a timed one has `startsAt` and `endsAt` (epoch ms, end exclusive) in `timezone`; an
 * all-day one has `startDate` and `endDate` (`YYYY-MM-DD`, end exclusive). A repeating one has `recurrence`, RFC 5545
 * lines as `EntryInput` holds them; its `timezone` is the zone the rule is expanded in, which Google requires.
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
  recurrence?: string[]
}

/**
 * Only the fields to change; `null` clears one. `attendees` and `recurrence` replace the whole list. A patch with
 * `startDate` for a timed event, or `startsAt` for an all-day one, switches it: the adapter clears the other kind.
 */
export type EventPatch = Partial<EventDraft>

/**
 * `this`: the one entry named; `series`: the repeating event it belongs to, named by the series' own id. A writer
 * receives only these two: cli-core makes `following` of a series change and a create (`FollowingScope`).
 */
export type WriteScope = "this" | "series"

/** A write's scope as the owner chooses it: `following` is this occurrence and every later one. */
export type FollowingScope = WriteScope | "following"

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
  /**
   * Optional: moves the event, keeping its id, to `target`, another calendar of the same account. `etag` is checked
   * before the move; a provider whose move takes no precondition reads the event first. A retry after
   * `outcome_unknown` that finds the event already on `target` returns it.
   */
  move?(
    calendar: StoredCalendar,
    externalId: string,
    target: StoredCalendar,
    options: { etag: string; notify: boolean },
  ): Promise<EntryInput>
}

/** Which write a command makes, for `CalendarWrites.extraKeys`. */
export type CalendarWrite = "create" | "update" | "delete" | "respond" | "move"

/** Mailing the other attendees: an agent may write to the calendar and still not to people (WC-PERM-14's spirit). */
export const EVENTS_NOTIFY_KEY: PermissionKey = "events.notify"
export const EVENTS_DELETE_SERIES_KEY: PermissionKey = "events.delete.series"

/** The keys the calendar writes check beyond their command paths, for a CLI's `commandPermissions({ extra })`. */
export const CALENDAR_WRITE_KEYS: readonly PermissionKey[] = [EVENTS_NOTIFY_KEY, EVENTS_DELETE_SERIES_KEY]

/**
 * Built in, and only ever tightening (WC-PERM-7). A change that is easy to undo goes ahead, as tg's and drive's writes
 * do; a deletion asks; a whole series is not deleted, and nobody is mailed.
 */
export const CALENDAR_WRITE_DEFAULTS: Readonly<Record<PermissionKey, Level>> = {
  "events.create": "allow",
  "events.update": "allow",
  "events.respond": "allow",
  "events.move": "allow",
  "events.delete": "ask",
  [EVENTS_DELETE_SERIES_KEY]: "deny",
  [EVENTS_NOTIFY_KEY]: "deny",
}

/** What an adapter throws when the provider refused a write because the entry's `etag` is old (HTTP 412). */
export const calendarConflict = (message = "the event changed at the provider since the last sync") =>
  new CliError("validation_error", `${message}; sync and try again`, { reason: "event.conflict" })
