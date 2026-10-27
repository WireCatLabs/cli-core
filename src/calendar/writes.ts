import { randomUUID } from "node:crypto"
import { CliError, isCliError } from "@wirecat/cli-base"
import { zonedMoment } from "@wirecat/cli-base/query"
import type { EntryInput, EventStore, StoredCalendar, StoredEntry, StoredParticipant } from "../meetings/index.js"
import type { AppIdentity } from "../ports/app.js"
import type { Warn } from "../runs/events.js"
import { type Asker, type GuardRequest, type GuardSettings, guardFor, type SendGuard } from "../sends/guard.js"
import { guardedWrite } from "../sends/guarded.js"
import { DEFAULT_PERMISSIONS, levelFor, type PermissionKey } from "../sends/permissions.js"
import { newOperationId } from "../sends/send-id.js"
import { calendarIn, entryItem, eventIdOf, eventOf, plusDays } from "./reads.js"
import { kindBoundLines, repeatRule, ruleCount, ruleEnd, ruleEndingBefore, ruleLine, splitDates } from "./recurrence.js"
import {
  CALENDAR_WRITE_DEFAULTS,
  type CalendarWrite,
  type CalendarWriter,
  EVENTS_DELETE_SERIES_KEY,
  EVENTS_NOTIFY_KEY,
  type EventDraft,
  type EventPatch,
  type EventResponse,
  type FollowingScope,
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
  /** An RFC 5545 rule, with or without `RRULE:`; on a change, only with the series' scope. */
  repeat?: string
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
  names: { notify: string; id: string; calendar: string; series: string; following: string; repeat: string }
}

/** Each write is checked by its command's path, the key a declared CLI's `commandPermissions` already knows. */
const COMMAND_KEY: Record<CalendarWrite, PermissionKey> = {
  create: "events.create",
  update: "events.update",
  delete: "events.delete",
  respond: "events.respond",
  move: "events.move",
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

/**
 * Typed fields into a draft, or into a patch with only what was given. `allDay` is the kind of the event a patch
 * changes, for a repeat rule's UNTIL when the patch keeps the times.
 */
export const draftOf = (
  fields: EventFields,
  zone: string,
  { whole, allDay = false }: { whole: boolean; allDay?: boolean },
): EventPatch => {
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
  if (fields.repeat !== undefined)
    patch.recurrence = [
      repeatRule(fields.repeat, {
        allDay: patch.startDate !== undefined || (patch.startsAt === undefined && allDay),
      }),
    ]
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

const answerOf = (operationId: string, saved: StoredEntry | undefined, repeats = false) => ({
  operation_id: operationId,
  event: saved?.eventId == null ? null : `event:${saved.eventId}`,
  entry: saved ? entryItem(saved) : null,
  // Only the series is saved here; its occurrences come with the provider's expansion on the next sync.
  ...(repeats ? { hint: "sync to store its occurrences" } : {}),
})

/** An id every provider takes as a client-chosen one: Google's base32hex `[a-v0-9]`, a CalDAV UID, a Graph id. */
export const newEventId = (): string => randomUUID().replaceAll("-", "")

const ID = /^[a-v0-9]{5,1024}$/u

const idOf = (context: WriteContext, given: string | undefined) => {
  if (given !== undefined && !ID.test(given))
    throw new CliError(
      "validation_error",
      `${context.names.id} is the id a create's outcome_unknown named: 5 to 1024 of a-v and 0-9`,
      { param: context.names.id },
    )
  return given ?? newEventId()
}

/** A create whose answer was lost names its id, so the owner's retry finds the event instead of making another. */
const retryable = async <T>(context: WriteContext, id: string, write: () => Promise<T>): Promise<T> => {
  try {
    return await write()
  } catch (error) {
    if (isCliError(error) && error.code === "outcome_unknown")
      throw new CliError(
        "outcome_unknown",
        `${error.message} — repeat with ${context.names.id} ${id}: the provider then finds the event ` +
          "instead of making a second one",
        { ...error.details, operation_id: id },
      )
    throw error
  }
}

export const createEvent = async (
  context: WriteContext,
  calendarReference: string,
  fields: EventFields,
  options: { notify?: boolean; id?: string } = {},
) => {
  const calendar = await calendarIn(context.store, context.accountId, calendarReference)
  const draft = draftOf(fields, context.zone, { whole: true }) as EventDraft
  const id = idOf(context, options.id)
  const notify = notifyOf(context, options.notify, (draft.attendees?.length ?? 0) > 0)
  const guard = writeGuard(context, keysFor(context, "create", notify))
  const entry = await retryable(context, id, () =>
    guardedWrite(
      guard,
      { chatId: null, kind: "edit", key: COMMAND_KEY.create, operationId: id, sendId: id, notify },
      () => context.writes.writer.create(calendar, draft, { id, notify }),
    ),
  )
  const [saved] = await context.store.saveEntries(calendar.id, [entry], context.now)
  return answerOf(id, saved, draft.recurrence !== undefined)
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
  { calendar, scope }: { calendar?: string; scope: FollowingScope },
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
  if (scope !== "this") {
    const flag = scope === "series" ? context.names.series : context.names.following
    if (entry.kind !== "occurrence" || !entry.seriesExternalId)
      throw new CliError("validation_error", `${reference} does not repeat; leave out ${flag}`, { param: flag })
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

interface ScopeChoice {
  calendar?: string
  series?: boolean
  /** This occurrence and every later one of its series. */
  following?: boolean
  notify?: boolean
}

const scopeOf = (context: WriteContext, { series, following }: ScopeChoice): FollowingScope => {
  if (series && following)
    throw new CliError("validation_error", `choose ${context.names.series} or ${context.names.following}, not both`, {
      param: context.names.following,
    })
  return following ? "following" : series ? "series" : "this"
}

export const updateEvent = async (
  context: WriteContext,
  reference: string,
  fields: EventFields,
  options: ScopeChoice & { id?: string } = {},
): Promise<object> => {
  if (scopeOf(context, options) === "following") return updateFollowing(context, reference, fields, options)
  if (options.id !== undefined)
    throw new CliError("validation_error", `${context.names.id} goes with ${context.names.following} only`, {
      param: context.names.id,
    })
  const scope: WriteScope = options.series ? "series" : "this"
  if (fields.repeat !== undefined && scope !== "series")
    throw new CliError("validation_error", `a repeat rule belongs to the whole series: add ${context.names.series}`, {
      param: context.names.series,
    })
  const { calendar, target, participants } = await targetOf(context, reference, { ...options, scope })
  const patch = draftOf(fields, context.zone, { whole: false, allDay: target.allDay })
  const kept = (target.recurrence ?? []).filter((line) => !/^RRULE:/iu.test(line))
  if (patch.recurrence) patch.recurrence = [...patch.recurrence, ...kept]
  const switching = patch.startDate !== undefined ? !target.allDay : patch.startsAt !== undefined && target.allDay
  const bound = kindBoundLines(patch.recurrence ? kept : (target.recurrence ?? []))
  if (switching && bound.length)
    throw new CliError(
      "validation_error",
      `${reference} repeats with ${bound.join(", ")}, which hold a ${target.allDay ? "date" : "time"}; ` +
        (patch.recurrence || bound.some((line) => !/^RRULE:/iu.test(line))
          ? "change its kind in the calendar itself"
          : `give its rule again with ${context.names.repeat} and UNTIL as a ${target.allDay ? "UTC time" : "date"}`),
      { reason: "event.repeat-kind" },
    )
  const notify = notifyOf(context, options.notify, hasOthers(participants) || (patch.attendees?.length ?? 0) > 0)
  const operationId = newOperationId()
  const entry = await guardedWrite(
    writeGuard(context, keysFor(context, "update", notify)),
    { chatId: null, kind: "edit", key: COMMAND_KEY.update, operationId, notify },
    () =>
      context.writes.writer.update(calendar, target.externalId, patch, { scope, etag: target.etag as string, notify }),
  )
  const [saved] = await context.store.saveEntries(calendar.id, [entry], context.now)
  return answerOf(operationId, saved, patch.recurrence !== undefined || (switching && scope === "series"))
}

export const deleteEvent = async (
  context: WriteContext,
  reference: string,
  options: ScopeChoice = {},
): Promise<object> => {
  if (scopeOf(context, options) === "following") return deleteFollowing(context, reference, options)
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

interface Split {
  /** The occurrence's slot as first scheduled: a moved occurrence still splits where it belonged. */
  at: number
  /** The slot is the series' first: the change is the whole series'. */
  first: boolean
  rule: string
  /** The series already ends before the slot: an earlier try split it. */
  ended: boolean
  /** The zone a floating EXDATE or RDATE is read in. */
  zone: string
}

const midnight = (date: string) => Date.parse(`${date}T00:00:00Z`)

const splitOf = (context: WriteContext, reference: string, { entry, target }: Target): Split => {
  if (entry.originalStartsAt === null)
    throw new CliError("not_found", `the slot of ${reference} in its series is not stored; sync and try again`)
  const at = entry.originalStartsAt
  const rule = ruleLine(target.recurrence ?? [])
  if (!rule)
    throw new CliError(
      "validation_error",
      `the series of ${reference} repeats by single dates only; change it in the calendar itself`,
      { reason: "event.repeat-split" },
    )
  const zone = target.timezone ?? context.zone
  const end = ruleEnd(rule, zone)
  const first = target.allDay
    ? target.startDate !== null && at <= midnight(target.startDate)
    : at <= (target.startsAt ?? 0)
  return { at, first, rule, ended: end !== undefined && end < at, zone }
}

/** The old series' rule ending before the split, with the dates and other lines that belong before it. */
const endedRecurrence = (target: StoredEntry, split: Split) => [
  ruleEndingBefore(split.rule, split.at, { allDay: target.allDay }),
  ...(target.recurrence ?? []).filter((line) => !/^(RRULE|EXDATE|RDATE)[:;]/iu.test(line)),
  ...splitDates(target.recurrence ?? [], split.at, split.zone).before,
]

/** Each later write of a split carries what was done already, so the owner's retry completes it without a double. */
const afterCreate = async <T>(context: WriteContext, id: string, write: () => Promise<T>): Promise<T> => {
  try {
    return await write()
  } catch (error) {
    if (!isCliError(error)) throw error
    throw new CliError(
      error.code,
      `${error.message}; the new series ${id} is made, so repeat with ${context.names.id} ${id}: it is found, not ` +
        "made again, and the old series is ended",
      { ...error.details, operation_id: id },
    )
  }
}

/**
 * "This and all following" from the writer's own writes, so every provider has it (RFC 5545 has no such change; Google
 * documents the same split: https://developers.google.com/workspace/calendar/api/guides/recurringevents#modifying_all_following_instances).
 * The new series is made first, under an id journaled before the call, and then the old one ends before the slot:
 * a conflict on the old series stops nothing being lost, and a retry with the id finds the new series. Until then
 * later slots show twice, never none.
 */
const updateFollowing = async (
  context: WriteContext,
  reference: string,
  fields: EventFields,
  options: ScopeChoice & { id?: string },
): Promise<object> => {
  const found = await targetOf(context, reference, { ...options, scope: "following" })
  const { calendar, entry, target, participants } = found
  const split = splitOf(context, reference, found)
  if (split.first && !split.ended) {
    const { following: _following, id: _id, ...rest } = options
    return updateEvent(context, reference, fields, { ...rest, series: true })
  }
  const patch = draftOf(fields, context.zone, { whole: false, allDay: target.allDay })
  if ((patch.startDate !== undefined && !target.allDay) || (patch.startsAt !== undefined && target.allDay))
    throw new CliError(
      "validation_error",
      `a switch between timed and all-day changes the whole series: use ${context.names.series}`,
      { param: context.names.series, reason: "event.repeat-kind" },
    )
  const count = ruleCount(split.rule)
  if (count !== undefined && !patch.recurrence)
    throw new CliError(
      "validation_error",
      `the series repeats COUNT=${count} times, and only the provider knows how many come from this occurrence on; ` +
        `give the new part its own rule with ${context.names.repeat}, ending with UNTIL or its own COUNT`,
      { param: context.names.repeat, reason: "event.repeat-count" },
    )
  if (split.ended && options.id === undefined)
    throw new CliError(
      "validation_error",
      `the series of ${reference} already ends before it; if a split ended in outcome_unknown, repeat it with ` +
        `${context.names.id} and the id it named`,
      { param: context.names.id, reason: "event.repeat-split" },
    )
  const id = idOf(context, options.id)
  const draft: EventDraft = {
    title: patch.title ?? target.title ?? "",
    ...(patch.startsAt !== undefined || patch.startDate !== undefined
      ? { startsAt: patch.startsAt, endsAt: patch.endsAt, startDate: patch.startDate, endDate: patch.endDate }
      : target.allDay
        ? {
            startDate: new Date(split.at).toISOString().slice(0, 10),
            endDate: new Date(split.at + midnight(target.endDate as string) - midnight(target.startDate as string))
              .toISOString()
              .slice(0, 10),
          }
        : { startsAt: split.at, endsAt: split.at + (target.endsAt ?? 0) - (target.startsAt ?? 0) }),
    timezone: patch.timezone ?? target.timezone ?? null,
    location: patch.location === undefined ? target.location : patch.location,
    description: patch.description === undefined ? target.description : patch.description,
    attendees:
      patch.attendees ??
      participants
        .filter(({ self }) => !self)
        .map(({ email, optional }) => ({ email, ...(optional ? { optional: true } : {}) })),
    recurrence: [
      patch.recurrence?.[0] ?? split.rule,
      ...splitDates(target.recurrence ?? [], split.at, split.zone).after,
    ],
  }
  for (const key of ["startsAt", "endsAt", "startDate", "endDate"] as const)
    if (draft[key] === undefined) delete draft[key]
  const notify = notifyOf(context, options.notify, hasOthers(participants) || (patch.attendees?.length ?? 0) > 0)
  const guard = writeGuard(context, [
    ...new Set([...keysFor(context, "create", notify), ...keysFor(context, "update", notify)]),
  ])
  const made = await retryable(context, id, () =>
    guardedWrite(
      guard,
      { chatId: null, kind: "edit", key: COMMAND_KEY.update, operationId: id, sendId: id, notify },
      () => context.writes.writer.create(calendar, draft, { id, notify }),
    ),
  )
  const written: EntryInput[] = [made]
  if (!split.ended)
    written.push(
      await afterCreate(context, id, () =>
        guardedWrite(
          guard,
          { chatId: null, kind: "edit", key: COMMAND_KEY.update, operationId: newOperationId(), notify },
          () =>
            context.writes.writer.update(
              calendar,
              target.externalId,
              { recurrence: endedRecurrence(target, split) },
              { scope: "series", etag: target.etag as string, notify },
            ),
        ),
      ),
    )
  const [saved, ended] = await context.store.saveEntries(calendar.id, written, context.now)
  return {
    operation_id: id,
    event: entry.eventId === null ? null : `event:${entry.eventId}`,
    scope: "following",
    entry: saved ? entryItem(saved) : null,
    ended: ended ? entryItem(ended) : null,
    hint: "sync to store the occurrences of both series",
  }
}

/**
 * The series ends before the occurrence. The earlier ones stay, so it takes the key of a deletion that asks, not the
 * series'.
 */
const deleteFollowing = async (context: WriteContext, reference: string, options: ScopeChoice): Promise<object> => {
  const found = await targetOf(context, reference, { ...options, scope: "following" })
  const { calendar, entry, target, participants } = found
  const split = splitOf(context, reference, found)
  if (split.first) {
    const { following: _following, ...rest } = options
    return deleteEvent(context, reference, { ...rest, series: true })
  }
  if (split.ended)
    throw new CliError("validation_error", `the series of ${reference} already ends before it; sync to see it`, {
      reason: "event.repeat-split",
    })
  const notify = notifyOf(context, options.notify, hasOthers(participants))
  const operationId = newOperationId()
  const recurrence = endedRecurrence(target, split)
  const written = await guardedWrite(
    writeGuard(context, keysFor(context, "update", notify)),
    { chatId: null, kind: "edit", key: COMMAND_KEY.delete, operationId, notify },
    () =>
      context.writes.writer.update(
        calendar,
        target.externalId,
        { recurrence },
        { scope: "series", etag: target.etag as string, notify },
      ),
  )
  const [ended] = await context.store.saveEntries(calendar.id, [written], context.now)
  const removed = await context.store.removeEntries(calendar.id, [entry.externalId], context.now)
  return {
    operation_id: operationId,
    event: entry.eventId === null ? null : `event:${entry.eventId}`,
    scope: "following",
    removed,
    ended: ended ? entryItem(ended) : null,
    ...(ruleCount(split.rule) === undefined ? {} : { converted: `COUNT became ${recurrence[0]?.slice(6)}` }),
    hint: "sync to cancel the later occurrences stored",
  }
}

const WRITABLE = new Set(["owner", "writer"])

/**
 * The event, under the same id, to another calendar of the same account. A repeating event moves whole: an
 * occurrence alone cannot change calendar at Google, and moving one copy of a series apart would split it.
 */
export const moveEvent = async (
  context: WriteContext,
  reference: string,
  toCalendar: string,
  options: { calendar?: string; series?: boolean; notify?: boolean } = {},
) => {
  const move = context.writes.writer.move?.bind(context.writes.writer)
  if (!move) throw new CliError("configuration_error", `${context.writes.writer.provider} cannot move events`)
  const { calendar, target, participants } = await targetOf(context, reference, {
    ...options,
    scope: options.series ? "series" : "this",
  })
  if (target.kind === "occurrence")
    throw new CliError(
      "validation_error",
      `${reference} is one occurrence of a repeating event, which moves whole: add ${context.names.series}`,
      { param: context.names.series },
    )
  const destination = await calendarIn(context.store, context.accountId, toCalendar)
  if (destination.id === calendar.id)
    throw new CliError("validation_error", `${reference} is on calendar ${calendar.id} already`)
  if (!WRITABLE.has(destination.accessRole ?? ""))
    throw new CliError("permission_error", `calendar ${destination.id} takes no new events from this account`, {
      reason: "calendar.read-only",
    })
  if (target.eventType && target.eventType !== "default")
    // https://developers.google.com/workspace/calendar/api/v3/reference/events/move: only default events move.
    throw new CliError("validation_error", `a ${target.eventType} event stays on its calendar`, {
      reason: "event.unmovable",
    })
  const notify = notifyOf(context, options.notify, hasOthers(participants))
  const operationId = newOperationId()
  const moved = await guardedWrite(
    writeGuard(context, keysFor(context, "move", notify)),
    { chatId: null, kind: "edit", key: COMMAND_KEY.move, operationId, notify },
    () => move(calendar, target.externalId, destination, { etag: target.etag as string, notify }),
  )
  await context.store.removeEntries(calendar.id, [target.externalId], context.now)
  // The shared UID joins the new copy to the same event as the cancelled one; a provider may leave it out of a move.
  const [saved] = await context.store.saveEntries(
    destination.id,
    [{ ...moved, icalUid: moved.icalUid ?? target.icalUid }],
    context.now,
  )
  return {
    ...answerOf(operationId, saved, target.kind === "series"),
    from_calendar: String(calendar.id),
    calendar: String(destination.id),
  }
}
