import { randomUUID } from "node:crypto"
import { CliError, isCliError } from "@wirecat/cli-base"
import { zonedMoment } from "@wirecat/cli-base/query"
import type { EventStore, StoredCalendar, StoredEntry, StoredParticipant } from "../meetings/index.js"
import type { AppIdentity } from "../ports/app.js"
import type { Warn } from "../runs/events.js"
import { type Asker, type GuardRequest, type GuardSettings, guardFor, type SendGuard } from "../sends/guard.js"
import { guardedWrite } from "../sends/guarded.js"
import { DEFAULT_PERMISSIONS, levelFor, type PermissionKey } from "../sends/permissions.js"
import { newOperationId } from "../sends/send-id.js"
import { calendarIn, entryItem, eventIdOf, eventOf, plusDays } from "./reads.js"
import {
  CALENDAR_WRITE_DEFAULTS,
  type CalendarWrite,
  type CalendarWriter,
  EVENTS_DELETE_SERIES_KEY,
  EVENTS_NOTIFY_KEY,
  type EventDraft,
  type EventPatch,
  type EventResponse,
  type WriteScope,
} from "./writer.js"

/** What a CLI or an MCP host hands the calendar writes for one profile. */
export interface CalendarWrites {
  writer: CalendarWriter
  app: AppIdentity
  /** The profile's levels, read on every write so a config change applies at once. */
  settings: () => GuardSettings
  /**
   * Keys a write must also pass beyond its command path, so denying them cannot be bypassed through the shared
   * commands: gcal names its generated API's (`api.calendar.events.insert`).
   */
  extraKeys?: (write: CalendarWrite) => readonly PermissionKey[]
  env?: NodeJS.ProcessEnv
  warn?: Warn
}

export const EVENT_RESPONSES: readonly EventResponse[] = ["accepted", "tentative", "declined"]

/** An event's fields as typed: times in the caller's zone; an all-day event's dates, `endDate` its last day. */
export interface EventFields {
  title?: string
  startTime?: string
  endTime?: string
  startDate?: string
  endDate?: string
  location?: string
  description?: string
  attendees?: string[]
}

export interface WriteContext {
  store: EventStore
  accountId: number
  writes: CalendarWrites
  /** A terminal's question, or an agent's go-ahead (WC-MCP-7). */
  ask: Asker
  now: number
  zone: string
  /** How the caller spells an input in a hint: `--notify or --no-notify` on the command line, `notify` over MCP. */
  names: { notify: string; id: string; calendar: string; series: string }
}

/** Each write is checked by its command's path, the key a declared CLI's `commandPermissions` already knows. */
const COMMAND_KEY: Record<CalendarWrite, PermissionKey> = {
  create: "events.create",
  update: "events.update",
  delete: "events.delete",
  respond: "events.respond",
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

const dateOf = (text: string, what: string) => {
  const [year, month, day] = text.split("-").map(Number) as [number, number, number]
  if (!DATE.test(text) || new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== text)
    throw new CliError("validation_error", `${what} of an all-day event is a date, YYYY-MM-DD`)
  return text
}

const momentOf = (text: string, zone: string) => zonedMoment(text, zone, { start: 0, end: text.length })

/** Typed fields into a draft, or into a patch with only what was given. */
export const draftOf = (fields: EventFields, zone: string, { whole }: { whole: boolean }): EventPatch => {
  const patch: EventPatch = {}
  if (fields.title !== undefined) {
    if (!fields.title.trim()) throw new CliError("validation_error", "an event needs a title")
    patch.title = fields.title.trim()
  } else if (whole) throw new CliError("validation_error", "an event needs a title")
  const timed = fields.startTime !== undefined || fields.endTime !== undefined
  const dated = fields.startDate !== undefined || fields.endDate !== undefined
  if (timed && dated) throw new CliError("validation_error", "an event has start and end times, or dates, not both")
  if (timed || dated || whole) {
    const [start, end] = dated ? [fields.startDate, fields.endDate] : [fields.startTime, fields.endTime]
    if (start === undefined || end === undefined)
      throw new CliError("validation_error", "an event needs its start and its end")
    if (dated) {
      patch.startDate = dateOf(start, "the start")
      patch.endDate = plusDays(dateOf(end, "the end"), 1)
      if (patch.endDate <= patch.startDate) throw new CliError("validation_error", "the event ends before it starts")
    } else {
      patch.startsAt = momentOf(start, zone)
      patch.endsAt = momentOf(end, zone)
      if (patch.endsAt <= patch.startsAt) throw new CliError("validation_error", "the event ends before it starts")
    }
    patch.timezone = zone
  }
  if (fields.location !== undefined) patch.location = fields.location.trim() || null
  if (fields.description !== undefined) patch.description = fields.description.trim() || null
  if (fields.attendees !== undefined)
    patch.attendees = [...new Set(fields.attendees.map((one) => one.trim().toLowerCase()))].map((email) => {
      if (!EMAIL.test(email)) throw new CliError("validation_error", `${email} is not an email address`)
      return { email }
    })
  if (!whole && Object.keys(patch).length === 0) throw new CliError("validation_error", "nothing to change")
  return patch
}

/**
 * Over the profile's guard, the write's other keys are checked too. A key that refuses is refused before anything is
 * asked, so nobody answers yes to a write that a stricter key then stops, and one answer covers every key of a write.
 */
const writeGuard = (context: WriteContext, extra: readonly PermissionKey[]): SendGuard => {
  const settings = context.writes.settings()
  const defaults = { ...DEFAULT_PERMISSIONS, ...CALENDAR_WRITE_DEFAULTS, ...settings.permissionDefaults }
  let question: string | undefined
  let answered = false
  const guard = guardFor(
    context.writes.app,
    { ...settings, permissionDefaults: defaults },
    context.writes.warn ?? (() => {}),
    context.writes.env,
    async (key, request) => {
      if (answered) return
      await context.ask(question ?? key, request)
      answered = true
    },
  )
  const probes = new WeakMap<GuardRequest, GuardRequest[]>()
  // A probe is checked and never journaled or counted: the write itself holds the one journal line.
  const all = (request: GuardRequest) => {
    let found = probes.get(request)
    if (!found) {
      found = extra.map((key) => ({ chatId: null, kind: "read" as const, key }))
      probes.set(request, found)
    }
    return [request, ...found]
  }
  return {
    ask: async (request) => {
      const levelOf = ({ key }: GuardRequest) => levelFor(settings.permissions, key as PermissionKey, defaults).level
      const refused = all(request).find((one) => ["deny", "readonly"].includes(levelOf(one)))
      if (refused) guard.check(refused, { reserve: false })
      // The one question names every key that asks, so a yes to the write is never a silent yes to mailing people.
      question = all(request)
        .filter((one) => levelOf(one) === "ask")
        .map(({ key }) => key)
        .join(" and ")
      for (const one of all(request)) await guard.ask?.(one)
    },
    check: (request, options) => {
      for (const one of all(request).slice(1)) guard.check(one, { reserve: false })
      guard.check(request, options)
    },
    ...(guard.reserve ? { reserve: guard.reserve } : {}),
    record: (entry) => guard.record(entry),
  }
}

const notifyOf = (context: WriteContext, choice: boolean | undefined, others: boolean): boolean => {
  if (choice !== undefined) return choice
  if (others)
    throw new CliError(
      "validation_error",
      `the event has attendees other than you: say whether the provider mails them (${context.names.notify})`,
      { reason: "event.notify-required", param: context.names.notify },
    )
  return false
}

const hasOthers = (participants: readonly Pick<StoredParticipant, "self" | "resource">[]) =>
  participants.some((one) => !one.self && !one.resource)

const keysFor = (context: WriteContext, write: CalendarWrite, notify: boolean): PermissionKey[] => [
  ...(context.writes.extraKeys?.(write) ?? []),
  ...(notify ? [EVENTS_NOTIFY_KEY] : []),
]

const answerOf = (operationId: string, saved: StoredEntry | undefined) => ({
  operation_id: operationId,
  event: saved?.eventId == null ? null : `event:${saved.eventId}`,
  entry: saved ? entryItem(saved) : null,
})

/** An id every provider takes as a client-chosen one: Google's base32hex `[a-v0-9]`, a CalDAV UID, a Graph id. */
export const newEventId = (): string => randomUUID().replaceAll("-", "")

const ID = /^[a-v0-9]{5,1024}$/u

export const createEvent = async (
  context: WriteContext,
  calendarReference: string,
  fields: EventFields,
  options: { notify?: boolean; id?: string } = {},
) => {
  const calendar = await calendarIn(context.store, context.accountId, calendarReference)
  const draft = draftOf(fields, context.zone, { whole: true }) as EventDraft
  if (options.id !== undefined && !ID.test(options.id))
    throw new CliError(
      "validation_error",
      `${context.names.id} is the id a create's outcome_unknown named: 5 to 1024 of a-v and 0-9`,
      {
        param: context.names.id,
      },
    )
  const notify = notifyOf(context, options.notify, (draft.attendees?.length ?? 0) > 0)
  const id = options.id ?? newEventId()
  const guard = writeGuard(context, keysFor(context, "create", notify))
  let entry: Awaited<ReturnType<CalendarWriter["create"]>>
  try {
    entry = await guardedWrite(
      guard,
      { chatId: null, kind: "edit", key: COMMAND_KEY.create, operationId: id, sendId: id, notify },
      () => context.writes.writer.create(calendar, draft, { id, notify }),
    )
  } catch (error) {
    if (isCliError(error) && error.code === "outcome_unknown")
      throw new CliError(
        "outcome_unknown",
        `${error.message} — repeat the create with ${context.names.id} ${id}: the provider then finds the event ` +
          "instead of making a second one",
        { ...error.details, operation_id: id },
      )
    throw error
  }
  const [saved] = await context.store.saveEntries(calendar.id, [entry], context.now)
  return answerOf(id, saved)
}

interface Target {
  calendar: StoredCalendar
  /** The entry the owner named. */
  entry: StoredEntry
  /** What the write changes: the entry, or its series. */
  target: StoredEntry
  participants: StoredParticipant[]
}

const targetOf = async (
  context: WriteContext,
  reference: string,
  { calendar, scope }: { calendar?: string; scope: WriteScope },
): Promise<Target> => {
  const details = await eventOf(context.store, context.accountId, eventIdOf(reference))
  const calendars = await context.store.calendars(context.accountId)
  const only = calendar === undefined ? undefined : await calendarIn(context.store, context.accountId, calendar)
  const live = details.entries.filter(
    (one) => one.deletedAt === null && one.status !== "cancelled" && (!only || one.calendarId === only.id),
  )
  const [entry] = live
  if (!entry) throw new CliError("not_found", `${reference} has no live copy${only ? ` on calendar ${only.id}` : ""}`)
  if (live.length > 1)
    throw new CliError(
      "validation_error",
      `${reference} is on calendars ${live.map(({ calendarId }) => calendarId).join(", ")}; name one with ` +
        `${context.names.calendar}`,
      { param: context.names.calendar },
    )
  let target = entry
  if (scope === "series") {
    if (entry.kind !== "occurrence" || !entry.seriesExternalId)
      throw new CliError("validation_error", `${reference} does not repeat; leave out ${context.names.series}`, {
        param: context.names.series,
      })
    const series = await context.store.entry(entry.calendarId, entry.seriesExternalId)
    if (!series) throw new CliError("not_found", `the series of ${reference} is not stored; sync and try again`)
    target = series
  }
  if (!target.etag)
    throw new CliError("validation_error", `no provider version is stored for ${reference}; sync and try again`, {
      reason: "event.conflict",
      sent: false,
    })
  return {
    calendar: calendars.find(({ id }) => id === entry.calendarId) as StoredCalendar,
    entry,
    target,
    participants: details.participants.filter(({ entryId }) => entryId === entry.id),
  }
}

export const updateEvent = async (
  context: WriteContext,
  reference: string,
  fields: EventFields,
  options: { calendar?: string; series?: boolean; notify?: boolean } = {},
) => {
  const patch = draftOf(fields, context.zone, { whole: false })
  const scope: WriteScope = options.series ? "series" : "this"
  const { calendar, target, participants } = await targetOf(context, reference, { ...options, scope })
  const notify = notifyOf(context, options.notify, hasOthers(participants) || (patch.attendees?.length ?? 0) > 0)
  const operationId = newOperationId()
  const entry = await guardedWrite(
    writeGuard(context, keysFor(context, "update", notify)),
    { chatId: null, kind: "edit", key: COMMAND_KEY.update, operationId, notify },
    () =>
      context.writes.writer.update(calendar, target.externalId, patch, { scope, etag: target.etag as string, notify }),
  )
  const [saved] = await context.store.saveEntries(calendar.id, [entry], context.now)
  return answerOf(operationId, saved)
}

export const deleteEvent = async (
  context: WriteContext,
  reference: string,
  options: { calendar?: string; series?: boolean; notify?: boolean } = {},
) => {
  const scope: WriteScope = options.series ? "series" : "this"
  const { calendar, entry, target, participants } = await targetOf(context, reference, { ...options, scope })
  const notify = notifyOf(context, options.notify, hasOthers(participants))
  const operationId = newOperationId()
  await guardedWrite(
    writeGuard(context, keysFor(context, "delete", notify)),
    {
      chatId: null,
      kind: "edit",
      key: scope === "series" ? EVENTS_DELETE_SERIES_KEY : COMMAND_KEY.delete,
      operationId,
      notify,
    },
    () => context.writes.writer.remove(calendar, target.externalId, { scope, etag: target.etag as string, notify }),
  )
  const removed = await context.store.removeEntries(calendar.id, [target.externalId], context.now)
  return {
    operation_id: operationId,
    event: entry.eventId === null ? null : `event:${entry.eventId}`,
    scope,
    removed,
  }
}

export const respondToEvent = async (
  context: WriteContext,
  reference: string,
  response: EventResponse,
  options: { calendar?: string; notify?: boolean } = {},
) => {
  if (!EVENT_RESPONSES.includes(response))
    throw new CliError("validation_error", `a response is one of ${EVENT_RESPONSES.join(", ")}`)
  const { calendar, target, participants } = await targetOf(context, reference, { ...options, scope: "this" })
  const notify = notifyOf(context, options.notify, hasOthers(participants))
  const operationId = newOperationId()
  const entry = await guardedWrite(
    writeGuard(context, keysFor(context, "respond", notify)),
    { chatId: null, kind: "edit", key: COMMAND_KEY.respond, operationId, notify },
    () => context.writes.writer.respond(calendar, target.externalId, response, { etag: target.etag as string, notify }),
  )
  const [saved] = await context.store.saveEntries(calendar.id, [entry], context.now)
  return answerOf(operationId, saved)
}
