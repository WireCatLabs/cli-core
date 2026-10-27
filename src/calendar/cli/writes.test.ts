import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import type { EntryInput } from "../../meetings/index.js"
import type { GuardSettings } from "../../sends/guard.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import type { Level } from "../../sends/permissions.js"
import { fakeCalendarWriter, memoryEventStore } from "../testing/index.js"
import type { CalendarWrites } from "../writes.js"
import { addCalendarCommands } from "./index.js"

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 27, 9)
const app = { command: "gcal", appName: "gcal-cli", envPrefix: "GCAL", description: "synthetic", version: "1.0.0" }

const review: EntryInput = {
  externalId: "e1",
  kind: "single",
  status: "confirmed",
  title: "Example review",
  startsAt: NOW + 2 * HOUR,
  endsAt: NOW + 3 * HOUR,
  participants: [
    { email: "owner@example.com", self: true, organizer: true, response: "accepted" },
    { email: "ana@example.com", response: "accepted" },
  ],
}
const series: EntryInput = {
  externalId: "s1",
  kind: "series",
  status: "confirmed",
  title: "Example standup",
  startsAt: NOW + HOUR,
  endsAt: NOW + 2 * HOUR,
  recurrence: ["RRULE:FREQ=DAILY"],
}
const slot: EntryInput = {
  ...series,
  externalId: "s1_1",
  kind: "occurrence",
  seriesExternalId: "s1",
  originalStartsAt: NOW + 25 * HOUR,
  startsAt: NOW + 25 * HOUR,
  endsAt: NOW + 26 * HOUR,
  recurrence: null,
}

const setup = async (
  options: { permissions?: Record<string, Level>; extraKeys?: CalendarWrites["extraKeys"]; lock?: string } = {},
) => {
  const store = memoryEventStore()
  const [calendar] = await store.saveCalendars(
    1,
    [
      {
        externalId: "primary",
        title: "Work",
        timezone: "UTC",
        accessRole: "owner",
        primary: true,
        syncByDefault: true,
      },
    ],
    NOW,
  )
  const writer = fakeCalendarWriter()
  await store.saveEntries(calendar?.id as number, writer.put("primary", review, series, slot), NOW)
  const home = mkdtempSync(join(tmpdir(), "calendar-writes-"))
  const env = { HOME: home, XDG_DATA_HOME: home }
  const settings = (): GuardSettings => ({
    profile: "work",
    permissions: options.permissions ?? {},
    permissionSources: {},
    sendsPerHour: 30,
    ...(options.lock ? { readOnlyLock: options.lock } : {}),
  })
  const written: Record<string, unknown>[] = []
  const cli = async (...args: string[]) => {
    const root = new Command("gcal").exitOverride().configureOutput({ writeErr: () => undefined })
    root.option("--yes").option("--dry-run")
    addCalendarCommands(root, {
      store,
      accountId: 1,
      account: { provider: "google-calendar", account: "owner-1" },
      write: (value) => written.push(value as Record<string, unknown>),
      now: () => NOW,
      timezone: "UTC",
      writes: { writer, app, settings, env, ...(options.extraKeys ? { extraKeys: options.extraKeys } : {}) },
    })
    await root.parseAsync([...args, "--json"], { from: "user" })
    return written.at(-1) as Record<string, unknown>
  }
  const journal = () => new SendJournal(sendsPathFor(app, "work", env)).entries()
  const eventOf = async (externalId: string) =>
    (await store.entry(calendar?.id as number, externalId))?.eventId as number
  return { store, writer, cli, journal, eventOf, calendarId: calendar?.id as number }
}

// A broader `events: allow` would not lift the built-in asks (WC-PERM-7): each key is named.
const ALLOW: Record<string, Level> = {
  "events.create": "allow",
  "events.update": "allow",
  "events.respond": "allow",
  "events.delete": "allow",
}
const create = ["events", "create", "primary", "--title", "Example planning"]
const at = ["--start-time", "2026-11-02T10:00", "--end-time", "2026-11-02T11:00"]

describe("calendar write commands", () => {
  it("exist only when the CLI passes a writer", () => {
    const root = new Command("gcal")
    addCalendarCommands(root, { store: memoryEventStore(), accountId: 1, account: {} as never, write: () => undefined })
    const events = root.commands.find((one) => one.name() === "events")
    expect(events?.commands.map((one) => one.name())).toEqual(["list", "show"])
  })

  it("create asks first, then journals its id before the provider sees it and saves the event", async () => {
    const { cli, writer, journal, store } = await setup()
    await expect(cli(...create, ...at)).rejects.toMatchObject({ code: "confirmation_required" })
    expect(writer.calls).toEqual([])
    let during: ReturnType<typeof journal> = []
    const created = writer.create
    writer.create = (...args) => {
      during = journal()
      return created(...args)
    }
    const made = await cli(...create, ...at, "--yes")
    const id = made.operation_id as string
    expect(writer.calls).toEqual([{ write: "create", calendar: "primary", externalId: id, notify: false }])
    expect(during.filter((line) => line.sendId === id)).toEqual([expect.objectContaining({ outcome: "reserved" })])
    expect(journal()).toEqual([
      expect.objectContaining({ outcome: "refused", key: "events.create", errorCode: "confirmation_required" }),
      expect.objectContaining({ outcome: "sent", sendId: id, key: "events.create", notify: false }),
    ])
    expect(made.event).toMatch(/^event:\d+$/u)
    const stored = await store.entry(1, id)
    expect(stored).toMatchObject({ title: "Example planning", startsAt: Date.UTC(2026, 10, 2, 10), etag: '"v4"' })
  })

  it("--dry-run previews a write and calls nothing", async () => {
    const { cli, writer, journal } = await setup({ permissions: ALLOW })
    await cli(...create, ...at, "--dry-run")
    expect(writer.calls).toEqual([])
    expect(journal()).toEqual([])
  })

  it("a create whose answer was lost names its id, and a retry with it finds the one event", async () => {
    const { cli, writer, store } = await setup({ permissions: ALLOW })
    writer.loseNextAnswer()
    const lost = await cli(...create, ...at).catch((error) => error)
    expect(lost).toMatchObject({ code: "outcome_unknown" })
    const id = lost.details.operation_id as string
    expect(lost.message).toContain(`--id ${id}`)
    await cli(...create, ...at, "--id", id)
    expect(writer.held("primary").filter(({ externalId }) => externalId === id)).toHaveLength(1)
    expect(await store.entry(1, id)).toMatchObject({ title: "Example planning" })
  })

  it("an event with other attendees needs --notify, and mailing them is denied until the owner allows it", async () => {
    const { cli, writer, eventOf } = await setup({ permissions: ALLOW })
    const event = `event:${await eventOf("e1")}`
    await expect(cli("events", "update", event, "--title", "Moved")).rejects.toMatchObject({
      details: { reason: "event.notify-required" },
    })
    await expect(cli(...create, ...at, "--attendee", "ana@example.com")).rejects.toMatchObject({
      details: { reason: "event.notify-required" },
    })
    await expect(cli(...create, ...at, "--attendee", "ana@example.com", "--notify")).rejects.toMatchObject({
      code: "permission_error",
      details: { permission: "events.notify" },
    })
    expect(writer.calls).toEqual([])
    await cli("events", "update", event, "--title", "Moved", "--no-notify")
    expect(writer.calls.at(-1)).toMatchObject({ write: "update", notify: false, scope: "this" })
  })

  it("with events.notify allowed, --notify all reaches the provider", async () => {
    const { cli, writer, eventOf } = await setup({ permissions: { ...ALLOW, "events.notify": "allow" } })
    await cli("events", "respond", `event:${await eventOf("e1")}`, "declined", "--notify")
    expect(writer.calls).toEqual([expect.objectContaining({ write: "respond", notify: true })])
  })

  it("a change made at the provider since the last sync is a conflict, and nothing is overwritten", async () => {
    const { cli, writer, eventOf, store } = await setup({ permissions: ALLOW })
    writer.changeBehind("primary", "e1")
    await expect(
      cli("events", "update", `event:${await eventOf("e1")}`, "--title", "Mine", "--no-notify"),
    ).rejects.toMatchObject({ code: "validation_error", details: { reason: "event.conflict" } })
    expect(writer.held("primary").find(({ externalId }) => externalId === "e1")?.title).toBe("Example review")
    expect((await store.entry(1, "e1"))?.title).toBe("Example review")
  })

  it("respond saves the owner's answer at once", async () => {
    const { cli, eventOf, store } = await setup()
    const answer = await cli("events", "respond", `event:${await eventOf("e1")}`, "tentative", "--no-notify", "--yes")
    expect(answer.entry).toMatchObject({ own_response: "tentative" })
    expect((await store.entry(1, "e1"))?.ownResponse).toBe("tentative")
  })

  it("deletes one occurrence, and a whole series only once the owner allows events.delete.series", async () => {
    const { cli, writer, eventOf, store } = await setup()
    const occurrence = `event:${await eventOf("s1_1")}`
    await expect(cli("events", "delete", occurrence, "--series", "--yes")).rejects.toMatchObject({
      code: "permission_error",
      details: { permission: "events.delete.series" },
    })
    expect(writer.calls).toEqual([])
    const one = await cli("events", "delete", occurrence, "--yes")
    expect(one).toMatchObject({ scope: "this", removed: 1 })
    expect(writer.calls.at(-1)).toMatchObject({ write: "remove", externalId: "s1_1", scope: "this" })
    expect((await store.entry(1, "s1_1"))?.status).toBe("cancelled")

    const allowed = await setup({ permissions: { "events.delete.series": "ask" } })
    const all = await allowed.cli("events", "delete", `event:${await allowed.eventOf("s1_1")}`, "--series", "--yes")
    expect(all).toMatchObject({ scope: "series" })
    expect(allowed.writer.calls.at(-1)).toMatchObject({ write: "remove", externalId: "s1", scope: "series" })
    expect((await allowed.store.entry(1, "s1"))?.status).toBe("cancelled")
  })

  it("a key the CLI adds is checked too, so denying its API cannot be bypassed", async () => {
    const { cli, writer } = await setup({
      permissions: { ...ALLOW, "api.calendar.events.insert": "deny" },
      extraKeys: (write) => (write === "create" ? ["api.calendar.events.insert"] : []),
    })
    await expect(cli(...create, ...at)).rejects.toMatchObject({
      code: "permission_error",
      details: { permission: "api.calendar.events.insert" },
    })
    expect(writer.calls).toEqual([])
  })

  it("readonly and the read-only lock refuse, and --yes lifts neither", async () => {
    const readonly = await setup({ permissions: { events: "readonly" } })
    await expect(readonly.cli(...create, ...at, "--yes")).rejects.toMatchObject({ code: "permission_error" })
    const locked = await setup({ permissions: { events: "allow" }, lock: "GCAL_READ_ONLY" })
    await expect(locked.cli(...create, ...at, "--yes")).rejects.toMatchObject({ code: "permission_error" })
    expect([...readonly.writer.calls, ...locked.writer.calls]).toEqual([])
  })

  it("an all-day event takes dates, its end the last day", async () => {
    const { cli, store } = await setup({ permissions: ALLOW })
    const made = await cli(...create, "--start-date", "2026-11-02", "--end-date", "2026-11-03")
    expect(await store.entry(1, made.operation_id as string)).toMatchObject({
      allDay: true,
      startDate: "2026-11-02",
      endDate: "2026-11-04",
    })
    await expect(
      cli(...create, "--start-time", "2026-11-02T11:00", "--end-time", "2026-11-02T10:00"),
    ).rejects.toMatchObject({
      code: "validation_error",
    })
  })
})
