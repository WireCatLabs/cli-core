import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isCliError } from "@wirecat/cli-base"
import type { ContractCase, EntryInput, StoredCalendar } from "../../meetings/index.js"
import type { GuardSettings } from "../../sends/guard.js"
import { ruleEnd } from "../recurrence.js"
import type { CalendarWriter, EventDraft } from "../writer.js"
import { createEvent, deleteEvent, updateEvent, type WriteContext } from "../writes.js"
import { memoryEventStore } from "./memory.js"

/** One writer over recorded or held responses, fresh for each case. */
export interface CalendarWriterFixture {
  writer: CalendarWriter
  calendar: StoredCalendar
  /** A single event the provider holds, with its current `etag`. */
  existing: EntryInput
  /** Another client changes `existing`, so its `etag` is old. */
  changeBehind: () => void | Promise<void>
  /** The next write takes effect, and its answer is lost: the writer throws `outcome_unknown`. */
  loseNextAnswer: () => void
  /** Whether each write so far asked the provider to mail the attendees, in order. */
  notified: () => boolean[]
  /** A time the provider accepts for a new event; the contract creates one-hour events from it. */
  at: number
  /** A second calendar of the same account, for a writer with `move`; its cases are skipped without one. */
  target?: StoredCalendar
}

const reasonOf = (error: unknown) => (isCliError(error) ? error.details.reason : undefined)

const rejectsWith = async (promise: Promise<unknown>, check: (error: unknown) => boolean, message: string) => {
  try {
    await promise
  } catch (error) {
    assert.ok(check(error), `${message}, got ${String(error)}`)
    return
  }
  assert.fail(`${message}, but it succeeded`)
}

const ID = "contract0sample0id0001"
const NEW_ID = "contract0sample0id0002"
const WEEK = 7 * 86_400_000
const WEEKLY = "RRULE:FREQ=WEEKLY;COUNT=3"
const WEEKLY_OPEN = "RRULE:FREQ=WEEKLY"
const DAILY = "RRULE:FREQ=DAILY;INTERVAL=2;COUNT=5"

/**
 * What every calendar writer keeps (gcal-cli plan §9, W1): a stale `etag` is a conflict, never an overwrite; a create
 * retried with its id finds the event; a repeat rule is kept as given and changed on the series; a timed event
 * switches to all-day and back; `notify: false` mails nobody, and a profile that keeps `events.notify` at its
 * default never reaches the provider with a write that would.
 */
const contextOver = async (
  f: CalendarWriterFixture,
  permissions: GuardSettings["permissions"],
): Promise<WriteContext & { calendarId: number }> => {
  const store = memoryEventStore()
  const [calendar] = await store.saveCalendars(1, [{ ...f.calendar, syncByDefault: true }], f.at)
  const home = mkdtempSync(join(tmpdir(), "calendar-writer-contract-"))
  return {
    calendarId: calendar?.id as number,
    store,
    accountId: 1,
    writes: {
      writer: f.writer,
      app: { command: "example", appName: "example-cli", envPrefix: "EXAMPLE", description: "", version: "0" },
      settings: () => ({ profile: "work", permissions, permissionSources: {}, sendsPerHour: 30 }),
      env: { HOME: home, XDG_DATA_HOME: home, EXAMPLE_STATE_DIR: home },
    },
    ask: async () => {},
    now: f.at,
    zone: "UTC",
    names: {
      notify: "notify",
      id: "id",
      calendar: "calendar",
      series: "series",
      following: "following",
      repeat: "repeat",
    },
  }
}

/** A weekly series the writer made, stored with its second occurrence as a sync would store it. */
const storedSeries = async (f: CalendarWriterFixture, context: WriteContext & { calendarId: number }) => {
  const series = await f.writer.create(
    f.calendar,
    { title: "Example planning", startsAt: f.at, endsAt: f.at + 3_600_000, timezone: "UTC", recurrence: [WEEKLY_OPEN] },
    { id: ID, notify: false },
  )
  const [, second] = await context.store.saveEntries(
    context.calendarId,
    [
      series,
      {
        externalId: `${ID}_second`,
        kind: "occurrence",
        seriesExternalId: ID,
        originalStartsAt: f.at + WEEK,
        status: "confirmed",
        title: "Example planning",
        startsAt: f.at + WEEK,
        endsAt: f.at + WEEK + 3_600_000,
        timezone: "UTC",
      },
    ],
    f.at,
  )
  return `event:${second?.eventId}`
}

const SPLIT = { "events.create": "allow", "events.update": "allow", "events.delete.series": "allow" } as const

export const calendarWriterContract = (fixture: () => CalendarWriterFixture | Promise<CalendarWriterFixture>) => {
  const draft = (at: number, extra: Partial<EventDraft> = {}): EventDraft => ({
    title: "Example planning",
    startsAt: at,
    endsAt: at + 3_600_000,
    timezone: "UTC",
    ...extra,
  })
  const cases: ContractCase[] = [
    {
      name: "a create returns the event with its etag",
      run: async () => {
        const f = await fixture()
        const made = await f.writer.create(f.calendar, draft(f.at), { id: ID, notify: false })
        assert.equal(made.title, "Example planning")
        assert.equal(made.status, "confirmed")
        assert.equal(typeof made.etag, "string")
      },
    },
    {
      name: "a create retried with the same id after a lost answer finds the event instead of making another",
      run: async () => {
        const f = await fixture()
        f.loseNextAnswer()
        await rejectsWith(
          f.writer.create(f.calendar, draft(f.at), { id: ID, notify: false }),
          (error) => isCliError(error) && error.code === "outcome_unknown",
          "a lost answer is outcome_unknown",
        )
        const retried = await f.writer.create(f.calendar, draft(f.at), { id: ID, notify: false })
        const again = await f.writer.create(f.calendar, draft(f.at), { id: ID, notify: false })
        assert.equal(again.externalId, retried.externalId)
      },
    },
    {
      name: "a change with the current etag returns a new one",
      run: async () => {
        const f = await fixture()
        const changed = await f.writer.update(
          f.calendar,
          f.existing.externalId,
          { title: "Example planning (moved)" },
          { scope: "this", etag: f.existing.etag as string, notify: false },
        )
        assert.equal(changed.title, "Example planning (moved)")
        assert.notEqual(changed.etag, f.existing.etag)
      },
    },
    ...(["update", "remove", "respond"] as const).map((write) => ({
      name: `${write} with an old etag is a conflict, never an overwrite`,
      run: async () => {
        const f = await fixture()
        await f.changeBehind()
        const options = { scope: "this" as const, etag: f.existing.etag as string, notify: false }
        const id = f.existing.externalId
        await rejectsWith(
          write === "update"
            ? f.writer.update(f.calendar, id, { title: "Overwritten" }, options)
            : write === "remove"
              ? f.writer.remove(f.calendar, id, options)
              : f.writer.respond(f.calendar, id, "declined", options),
          (error) => reasonOf(error) === "event.conflict",
          "a stale etag is a calendarConflict()",
        )
      },
    })),
    {
      name: "a create with a repeat rule returns the series holding that rule",
      run: async () => {
        const f = await fixture()
        const made = await f.writer.create(f.calendar, draft(f.at, { recurrence: [WEEKLY] }), {
          id: ID,
          notify: false,
        })
        assert.equal(made.kind, "series")
        assert.deepEqual(made.recurrence, [WEEKLY])
      },
    },
    {
      name: "a change of the series' rule replaces it",
      run: async () => {
        const f = await fixture()
        const made = await f.writer.create(f.calendar, draft(f.at, { recurrence: [WEEKLY] }), {
          id: ID,
          notify: false,
        })
        const changed = await f.writer.update(
          f.calendar,
          made.externalId,
          { recurrence: [DAILY] },
          { scope: "series", etag: made.etag as string, notify: false },
        )
        assert.deepEqual(changed.recurrence, [DAILY])
        assert.notEqual(changed.etag, made.etag)
      },
    },
    {
      name: "a timed event becomes all-day, and back",
      run: async () => {
        const f = await fixture()
        const made = await f.writer.create(f.calendar, draft(f.at), { id: ID, notify: false })
        const day = new Date(f.at).toISOString().slice(0, 10)
        const next = new Date(f.at + 86_400_000).toISOString().slice(0, 10)
        const allDay = await f.writer.update(
          f.calendar,
          made.externalId,
          { startDate: day, endDate: next, timezone: "UTC" },
          { scope: "this", etag: made.etag as string, notify: false },
        )
        assert.equal(allDay.allDay, true)
        assert.equal(allDay.startDate, day)
        const timed = await f.writer.update(
          f.calendar,
          made.externalId,
          { startsAt: f.at, endsAt: f.at + 3_600_000, timezone: "UTC" },
          { scope: "this", etag: allDay.etag as string, notify: false },
        )
        assert.equal(timed.allDay ?? false, false)
        assert.equal(timed.startsAt, f.at)
        assert.equal(timed.startDate ?? null, null)
      },
    },
    {
      name: "notify reaches the provider as given: false mails nobody",
      run: async () => {
        const f = await fixture()
        const before = f.notified().length
        await f.writer.create(f.calendar, draft(f.at, { attendees: [{ email: "ana@example.com" }] }), {
          id: ID,
          notify: false,
        })
        await f.writer.respond(f.calendar, f.existing.externalId, "accepted", {
          etag: f.existing.etag as string,
          notify: true,
        })
        assert.deepEqual(f.notified().slice(before), [false, true])
      },
    },
    {
      name: "with events.notify at its default, a create that would mail attendees is refused before the provider",
      run: async () => {
        const f = await fixture()
        const context = await contextOver(f, { events: "allow" })
        const before = f.notified().length
        await rejectsWith(
          createEvent(
            context,
            String(context.calendarId),
            {
              title: "Example planning",
              startTime: new Date(f.at).toISOString(),
              endTime: new Date(f.at + 3_600_000).toISOString(),
              attendees: ["ana@example.com"],
            },
            { notify: true },
          ),
          (error) => isCliError(error) && error.code === "permission_error",
          "events.notify is deny by default",
        )
        assert.equal(f.notified().length, before, "the provider was not called")
      },
    },
    {
      name: "following: the series ends before the occurrence, and a new one starts there with the change",
      run: async () => {
        const f = await fixture()
        const context = await contextOver(f, SPLIT)
        const occurrence = await storedSeries(f, context)
        const answer = (await updateEvent(
          context,
          occurrence,
          { title: "Example planning (later)" },
          {
            following: true,
            notify: false,
            id: NEW_ID,
          },
        )) as { entry: { external_id: string } | null }
        const old = await context.store.entry(context.calendarId, ID)
        const ends = ruleEnd(old?.recurrence?.[0] ?? "", "UTC")
        assert.ok(
          ends !== undefined && ends >= f.at && ends < f.at + WEEK,
          "the first occurrence stays, the second goes",
        )
        const made = await context.store.entry(context.calendarId, NEW_ID)
        assert.equal(answer.entry?.external_id, NEW_ID)
        assert.equal(made?.kind, "series")
        assert.equal(made?.title, "Example planning (later)")
        assert.equal(made?.startsAt, f.at + WEEK)
        assert.deepEqual(made?.recurrence, [WEEKLY_OPEN])
      },
    },
    {
      name: "following: a retry with the id after a lost answer finds the new series instead of making a second",
      run: async () => {
        const f = await fixture()
        const context = await contextOver(f, SPLIT)
        const occurrence = await storedSeries(f, context)
        const change = { title: "Example planning (later)" }
        f.loseNextAnswer()
        let named: unknown
        await rejectsWith(
          updateEvent(context, occurrence, change, { following: true, notify: false }),
          (error) => {
            named = isCliError(error) ? error.details.operation_id : undefined
            return isCliError(error) && error.code === "outcome_unknown" && typeof named === "string"
          },
          "a lost answer is outcome_unknown naming the new series' id",
        )
        const again = (await updateEvent(context, occurrence, change, {
          following: true,
          notify: false,
          id: named as string,
        })) as { entry: { external_id: string } | null; ended: object | null }
        assert.equal(again.entry?.external_id, named)
        assert.ok(again.ended, "the old series is ended on the retry")
        const ends = ruleEnd((await context.store.entry(context.calendarId, ID))?.recurrence?.[0] ?? "", "UTC")
        assert.ok(ends !== undefined && ends < f.at + WEEK)
      },
    },
    {
      name: "following: a deletion ends the series before the occurrence and makes nothing",
      run: async () => {
        const f = await fixture()
        const context = await contextOver(f, SPLIT)
        const occurrence = await storedSeries(f, context)
        await deleteEvent(context, occurrence, { following: true, notify: false })
        const ends = ruleEnd((await context.store.entry(context.calendarId, ID))?.recurrence?.[0] ?? "", "UTC")
        assert.ok(ends !== undefined && ends >= f.at && ends < f.at + WEEK)
      },
    },
    ...moveCases(fixture),
  ]
  return cases
}

const moveCases = (fixture: () => CalendarWriterFixture | Promise<CalendarWriterFixture>): ContractCase[] => {
  const ready = async () => {
    const f = await fixture()
    return f.writer.move && f.target ? { ...f, move: f.writer.move.bind(f.writer), target: f.target } : undefined
  }
  return [
    {
      name: "move: the event keeps its id on the other calendar, with a new etag",
      run: async () => {
        const f = await ready()
        if (!f) return
        const moved = await f.move(f.calendar, f.existing.externalId, f.target, {
          etag: f.existing.etag as string,
          notify: false,
        })
        assert.equal(moved.externalId, f.existing.externalId)
        assert.equal(typeof moved.etag, "string")
      },
    },
    {
      name: "move: an old etag is a conflict, and the event stays",
      run: async () => {
        const f = await ready()
        if (!f) return
        await f.changeBehind()
        await rejectsWith(
          f.move(f.calendar, f.existing.externalId, f.target, { etag: f.existing.etag as string, notify: false }),
          (error) => reasonOf(error) === "event.conflict",
          "a stale etag is a calendarConflict()",
        )
      },
    },
    {
      name: "move: a retry after a lost answer finds the event on the other calendar",
      run: async () => {
        const f = await ready()
        if (!f) return
        const options = { etag: f.existing.etag as string, notify: false }
        f.loseNextAnswer()
        await rejectsWith(
          f.move(f.calendar, f.existing.externalId, f.target, options),
          (error) => isCliError(error) && error.code === "outcome_unknown",
          "a lost answer is outcome_unknown",
        )
        const found = await f.move(f.calendar, f.existing.externalId, f.target, options)
        assert.equal(found.externalId, f.existing.externalId)
      },
    },
  ]
}
