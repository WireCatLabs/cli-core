import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isCliError } from "@wirecat/cli-base"
import type { ContractCase, EntryInput, StoredCalendar } from "../../meetings/index.js"
import type { CalendarWriter, EventDraft } from "../writer.js"
import { createEvent } from "../writes.js"
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

const ID = "contract0example0id0001"

/**
 * What every calendar writer keeps (gcal-cli plan §9, W1): a stale `etag` is a conflict, never an overwrite; a create
 * retried with its id finds the event; `notify: false` mails nobody, and a profile that keeps `events.notify` at its
 * default never reaches the provider with a write that would.
 */
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
        const store = memoryEventStore()
        const [calendar] = await store.saveCalendars(1, [{ ...f.calendar, syncByDefault: true }], f.at)
        const home = mkdtempSync(join(tmpdir(), "calendar-writer-contract-"))
        const before = f.notified().length
        await rejectsWith(
          createEvent(
            {
              store,
              accountId: 1,
              writes: {
                writer: f.writer,
                app: {
                  command: "example",
                  appName: "example-cli",
                  envPrefix: "EXAMPLE",
                  description: "",
                  version: "0",
                },
                settings: () => ({
                  profile: "work",
                  permissions: { events: "allow" },
                  permissionSources: {},
                  sendsPerHour: 30,
                }),
                env: { HOME: home, XDG_DATA_HOME: home, EXAMPLE_STATE_DIR: home },
              },
              ask: async () => {},
              now: f.at,
              zone: "UTC",
              names: { notify: "notify", id: "id", calendar: "calendar", series: "series" },
            },
            String(calendar?.id),
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
  ]
  return cases
}
