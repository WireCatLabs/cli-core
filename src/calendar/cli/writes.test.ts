import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, errorObjectOf } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { commandPermissions, knownPermissionKeys } from "../../cli/permission-keys.js"
import { type AgentProgram, runCommandForAgent, toolsFromCommands } from "../../mcp/agent.js"
import type { EntryInput } from "../../meetings/index.js"
import type { GuardSettings } from "../../sends/guard.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import type { Level } from "../../sends/permissions.js"
import { CALENDAR_UNTRUSTED_FIELDS } from "../reads.js"
import { checkCalendarAnswer } from "../testing/answers.js"
import { fakeCalendarWriter, memoryEventStore } from "../testing/index.js"
import { CALENDAR_WRITE_KEYS } from "../writer.js"
import { type CalendarWrites, createEvent, newEventId, updateEvent } from "../writes.js"
import { addCalendarCommands } from "./index.js"

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 27, 9)
const app = { command: "gcal", appName: "gcal-cli", envPrefix: "GCAL", description: "synthetic", version: "1.0.0" }

const review: EntryInput = {
  externalId: "e1",
  icalUid: "e1@example.com",
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
      {
        externalId: "family",
        title: "Family",
        timezone: "UTC",
        accessRole: "writer",
        primary: false,
        syncByDefault: true,
      },
      {
        externalId: "holidays",
        title: "Holidays",
        timezone: "UTC",
        accessRole: "reader",
        primary: false,
        syncByDefault: true,
      },
    ],
    NOW,
  )
  const writer = fakeCalendarWriter()
  await store.saveEntries(calendar?.id as number, writer.put("primary", review, series, slot), NOW)
  const home = mkdtempSync(join(tmpdir(), "calendar-writes-"))
  const env = { HOME: home, XDG_DATA_HOME: home, GCAL_STATE_DIR: home }
  const settings = (): GuardSettings => ({
    profile: "work",
    permissions: options.permissions ?? {},
    permissionSources: {},
    sendsPerHour: 30,
    ...(options.lock ? { readOnlyLock: options.lock } : {}),
  })
  const written: Record<string, unknown>[] = []
  const program = () => {
    const root = new Command("gcal").exitOverride().configureOutput({ writeErr: () => undefined })
    root.option("--yes").option("--dry-run").option("--json").option("--jsonl")
    addCalendarCommands(root, {
      store,
      accountId: 1,
      account: { provider: "google-calendar", account: "owner-1" },
      write: (value) => written.push(value as Record<string, unknown>),
      now: () => NOW,
      timezone: "UTC",
      writes: { writer, app, settings, env, ...(options.extraKeys ? { extraKeys: options.extraKeys } : {}) },
    })
    return root
  }
  const parse = async (args: string[]) => {
    const root = program()
    const before = written.length
    await root.parseAsync(args, { from: "user" })
    if (written.length > before) checkCalendarAnswer(root, args, written.at(-1))
    return written.at(-1) as Record<string, unknown>
  }
  const cli = (...args: string[]) => parse([...args, "--json"])
  const journal = () => new SendJournal(sendsPathFor(app, "work", env)).entries()
  const eventOf = async (externalId: string) =>
    (await store.entry(calendar?.id as number, externalId))?.eventId as number
  return { store, writer, cli, parse, program, journal, eventOf, calendarId: calendar?.id as number }
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

  it("create asks when the owner set it to, then journals its id before the provider sees it", async () => {
    const { cli, writer, journal, store } = await setup({ permissions: { "events.create": "ask" } })
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
    expect(lost.message).toContain(`--operation-id ${id}`)
    await cli(...create, ...at, "--operation-id", id)
    expect(writer.held("primary").filter(({ externalId }) => externalId === id)).toHaveLength(1)
    expect(await store.entry(1, id)).toMatchObject({ title: "Example planning" })
  })

  it("a create the store fails to save names the event's id, and a retry with it finds the one event", async () => {
    const { cli, writer, store } = await setup({ permissions: ALLOW })
    const save = store.saveEntries
    store.saveEntries = async () => {
      store.saveEntries = save
      throw new CliError("provider_unavailable", "database is locked", { reason: "store.locked" })
    }
    const failed = await cli(...create, ...at).catch((error) => error)
    const id = failed.details.operation_id as string
    expect(failed).toMatchObject({ code: "provider_unavailable", details: { reason: "store.locked", id } })
    expect(failed.message).toContain(`--operation-id ${id}`)
    await cli(...create, ...at, "--operation-id", id)
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

  it("one question names events.notify when it asks too, so a yes to the change is not a silent yes to mailing", async () => {
    const { store, writer, eventOf } = await setup({ permissions: { "events.notify": "ask" } })
    const asked: string[] = []
    const context = {
      store,
      accountId: 1,
      writes: {
        writer,
        app,
        settings: () => ({
          profile: "work",
          permissions: { "events.update": "ask" as Level, "events.notify": "ask" as Level },
          permissionSources: {},
          sendsPerHour: 30,
        }),
        env: { HOME: mkdtempSync(join(tmpdir(), "calendar-ask-")) },
      },
      ask: async (key: string) => {
        asked.push(key)
        throw new CliError("cancelled", "no")
      },
      now: NOW,
      zone: "UTC",
      names: {
        notify: "--notify",
        id: "--id",
        calendar: "--calendar",
        series: "--series",
        following: "--following",
        repeat: "--repeat",
      },
    }
    await expect(
      updateEvent(context, `event:${await eventOf("e1")}`, { title: "Moved" }, { notify: true }),
    ).rejects.toMatchObject({ code: "cancelled" })
    expect(asked).toEqual(["events.update and events.notify"])
    expect(writer.calls).toEqual([])
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
    expect(answer.untrusted).toEqual(CALENDAR_UNTRUSTED_FIELDS)
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

  it("a CLI that names CALENDAR_WRITE_KEYS lets the owner set events.notify and events.delete.series", () => {
    const root = new Command("gcal")
    addCalendarCommands(root, {
      store: memoryEventStore(),
      accountId: 1,
      account: {} as never,
      write: () => undefined,
      writes: { writer: fakeCalendarWriter(), app, settings: () => ({}) as never },
    })
    const known = knownPermissionKeys(root, commandPermissions({ extra: CALENDAR_WRITE_KEYS }))
    for (const key of ["events.create", "events.update", "events.delete", "events.respond", ...CALENDAR_WRITE_KEYS])
      expect(known).toContain(key)
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

  it("--repeat makes a series with its rule in RFC 5545 order, and says to sync for its occurrences", async () => {
    const { cli, store } = await setup({ permissions: ALLOW })
    const made = await cli(...create, ...at, "--repeat", "byday=mo,we;freq=weekly;count=6")
    expect(made.hint).toBe("sync to store its occurrences")
    expect(await store.entry(1, made.operation_id as string)).toMatchObject({
      kind: "series",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6"],
    })
    await expect(cli(...create, ...at, "--repeat", "FREQ=WEEKLY;UNTIL=20261231")).rejects.toMatchObject({
      details: { reason: "event.repeat-invalid" },
    })
  })

  it("a series' rule changes only with --series, keeping its EXDATE lines", async () => {
    const { cli, store, writer, eventOf } = await setup({ permissions: ALLOW })
    const event = `event:${await eventOf("s1_1")}`
    await expect(cli("events", "update", event, "--repeat", "FREQ=WEEKLY")).rejects.toMatchObject({
      details: { param: "--series" },
    })
    expect(writer.calls).toEqual([])
    await cli("events", "update", event, "--series", "--repeat", "FREQ=WEEKLY;INTERVAL=2")
    expect((await store.entry(1, "s1"))?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;INTERVAL=2"])
  })

  it("a rule that ends the series sooner deletes its later slots, so it needs events.delete.series too", async () => {
    const denied = await setup({ permissions: ALLOW })
    const event = `event:${await denied.eventOf("s1_1")}`
    for (const repeat of ["FREQ=DAILY;COUNT=3", "FREQ=DAILY;UNTIL=20261231T230000Z"])
      await expect(denied.cli("events", "update", event, "--series", "--repeat", repeat)).rejects.toMatchObject({
        code: "permission_error",
        details: { permission: "events.delete.series" },
      })
    expect(denied.writer.calls).toEqual([])
    const allowed = await setup({ permissions: { ...ALLOW, "events.delete.series": "allow" } })
    await allowed.cli("events", "update", event, "--series", "--repeat", "FREQ=DAILY;COUNT=3")
    expect((await allowed.store.entry(1, "s1"))?.recurrence).toEqual(["RRULE:FREQ=DAILY;COUNT=3"])
    await allowed.cli("events", "update", event, "--series", "--repeat", "FREQ=DAILY;COUNT=5")
    expect(allowed.writer.calls).toHaveLength(2)
  })

  it("new dates switch a timed event to all-day, and new times switch it back", async () => {
    const { cli, store, eventOf } = await setup({ permissions: ALLOW })
    const event = `event:${await eventOf("e1")}`
    await cli("events", "update", event, "--start-date", "2026-11-02", "--end-date", "2026-11-02", "--no-notify")
    expect(await store.entry(1, "e1")).toMatchObject({ allDay: true, startDate: "2026-11-02", startsAt: null })
    await cli("events", "update", event, ...at, "--no-notify")
    expect(await store.entry(1, "e1")).toMatchObject({
      allDay: false,
      startDate: null,
      startsAt: Date.UTC(2026, 10, 2, 10),
    })
  })

  it("a series whose rule ends on a time does not switch to all-day without a new rule", async () => {
    const { cli, store, writer, eventOf, calendarId } = await setup({ permissions: ALLOW })
    await store.saveEntries(
      calendarId,
      writer.put("primary", { ...series, recurrence: ["RRULE:FREQ=DAILY;UNTIL=20261231T230000Z"] }),
      NOW,
    )
    const event = `event:${await eventOf("s1_1")}`
    const calls = writer.calls.length
    await expect(
      cli("events", "update", event, "--series", "--start-date", "2026-11-02", "--end-date", "2026-11-02"),
    ).rejects.toMatchObject({ details: { reason: "event.repeat-kind" } })
    await cli(
      ...["events", "update", event, "--series", "--start-date", "2026-11-02", "--end-date", "2026-11-02"],
      ...["--repeat", "FREQ=DAILY;UNTIL=20261231"],
    )
    expect(writer.calls.length).toBe(calls + 1)
    expect(await store.entry(1, "s1")).toMatchObject({ allDay: true, recurrence: ["RRULE:FREQ=DAILY;UNTIL=20261231"] })
  })
})

describe("calendar writes through an agent's command tools", () => {
  const agent = async () => {
    const at = await setup({ permissions: { ...ALLOW, "events.notify": "allow" } })
    const program: AgentProgram = {
      commands: describeProgram(at.program()),
      run: async (argv, environment) => {
        try {
          environment.agent?.result(await at.parse(argv.slice(1)))
          return 0
        } catch (error) {
          environment.agent?.failure(errorObjectOf(error))
          return 1
        }
      },
    }
    const tool = (command: string) => toolsFromCommands(program.commands).find((one) => one.command === command)
    const call = (command: string, input: Record<string, unknown>) =>
      runCommandForAgent(program, command.split(" "), input, { profile: "work" })
    return { ...at, tool, call }
  }
  const times = { start_time: "2026-11-02T10:00", end_time: "2026-11-02T11:00" }

  it("take several attendees, and one notify that says --no-notify when false", async () => {
    const { tool, call, writer } = await agent()
    const create = tool("events create")
    expect(Object.keys(create?.input.entries ?? {})).not.toContain("no_notify")
    const input = { calendar: "primary", title: "Example planning", ...times, notify: false }
    const attendee = ["ana@example.com", "bob@example.com"]
    expect(v.safeParse(create?.input as v.GenericSchema, { ...input, attendee }).success).toBe(true)
    const made = await call("events create", { ...input, attendee })
    expect(made).toMatchObject({ result: { entry: { title: "Example planning" } } })
    const id = (made as { result: { operation_id: string } }).result.operation_id
    expect(writer.calls.at(-1)).toMatchObject({ write: "create", notify: false })
    expect(writer.held("primary").find((one) => one.externalId === id)?.participants).toEqual([
      expect.objectContaining({ email: "ana@example.com" }),
      expect.objectContaining({ email: "bob@example.com" }),
    ])
  })

  it("clear a place and details with empty text, and leave the attendees alone when none are given", async () => {
    const { tool, call, writer, eventOf, store } = await agent()
    const update = tool("events update")
    const input = { event: `event:${await eventOf("e1")}`, location: "", description: "", notify: false }
    expect(v.safeParse(update?.input as v.GenericSchema, input).success).toBe(true)
    expect(v.safeParse(update?.input as v.GenericSchema, { ...input, location: "-" }).success).toBe(false)
    expect(await call("events update", { ...input, location: "Room 2" })).toMatchObject({ result: {} })
    expect(await store.entry(1, "e1")).toMatchObject({ location: "Room 2" })
    expect(await call("events update", input)).toMatchObject({ result: { entry: { title: "Example review" } } })
    expect(await store.entry(1, "e1")).toMatchObject({ location: null, description: null })
    expect(writer.held("primary").find((one) => one.externalId === "e1")?.participants).toHaveLength(2)
  })
})

describe("event ids", () => {
  it("are minted and taken in Google's base32hex: a-v and 0-9, 5 to 1024 of them", async () => {
    expect(newEventId()).toMatch(/^[a-v0-9]{5,1024}$/u)
    const { store, writer } = await setup({ permissions: ALLOW })
    const context = {
      store,
      accountId: 1,
      writes: {
        writer,
        app,
        settings: () => ({ profile: "work", permissions: ALLOW, permissionSources: {}, sendsPerHour: 30 }),
      },
      ask: async () => {},
      now: NOW,
      zone: "UTC",
      names: {
        notify: "--notify",
        id: "--id",
        calendar: "--calendar",
        series: "--series",
        following: "--following",
        repeat: "--repeat",
      },
    }
    const fields = { title: "Example planning", startTime: "2026-11-02T10:00", endTime: "2026-11-02T11:00" }
    for (const id of ["example0id0w", "abcd", "ABCDEF123"])
      await expect(createEvent(context, "primary", fields, { id })).rejects.toMatchObject({ code: "validation_error" })
    expect(await createEvent(context, "primary", fields, { id: "abcdefghijklmnopqrstuv0123" })).toMatchObject({
      operation_id: "abcdefghijklmnopqrstuv0123",
    })
  })
})

const DAY = 24 * HOUR
const weekly: EntryInput = {
  externalId: "w1",
  kind: "series",
  status: "confirmed",
  title: "Example weekly",
  startsAt: NOW + HOUR,
  endsAt: NOW + 2 * HOUR,
  timezone: "UTC",
  recurrence: ["RRULE:FREQ=WEEKLY;WKST=MO", "EXDATE:20261103T100000Z,20261117T100000Z"],
  participants: [
    { email: "owner@example.com", self: true, organizer: true },
    { email: "ana@example.com", optional: true },
  ],
}
const third: EntryInput = {
  ...weekly,
  externalId: "w1_3",
  kind: "occurrence",
  seriesExternalId: "w1",
  originalStartsAt: NOW + HOUR + 14 * DAY,
  startsAt: NOW + HOUR + 14 * DAY,
  endsAt: NOW + 2 * HOUR + 14 * DAY,
  recurrence: null,
}
const SPLIT: Record<string, Level> = { ...ALLOW, "events.delete.series": "allow" }

const withWeekly = async (options: Parameters<typeof setup>[0] = {}) => {
  const tools = await setup(options)
  const first = {
    ...third,
    externalId: "w1_1",
    originalStartsAt: NOW + HOUR,
    startsAt: NOW + HOUR,
    endsAt: NOW + 2 * HOUR,
  }
  await tools.store.saveEntries(tools.calendarId, tools.writer.put("primary", weekly, first, third), NOW)
  return { ...tools, slot: `event:${await tools.eventOf("w1_3")}`, opening: `event:${await tools.eventOf("w1_1")}` }
}

describe("events update and delete --following", () => {
  it("ends the series before the occurrence and starts a new one with the change, its attendees and later dates", async () => {
    const { cli, writer, store, slot } = await withWeekly({ permissions: SPLIT })
    const answer = await cli("events", "update", slot, "--following", "--title", "Example weekly (new)", "--no-notify")
    const id = answer.operation_id as string
    expect(answer).toMatchObject({ scope: "following", entry: { external_id: id }, ended: { external_id: "w1" } })
    expect(writer.calls.map(({ write, externalId, scope }) => [write, externalId, scope])).toEqual([
      ["create", id, undefined],
      ["update", "w1", "series"],
    ])
    expect((await store.entry(1, "w1"))?.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;WKST=MO;UNTIL=20261110T095959Z",
      "EXDATE:20261103T100000Z",
    ])
    expect(await store.entry(1, id)).toMatchObject({
      kind: "series",
      title: "Example weekly (new)",
      startsAt: NOW + HOUR + 14 * DAY,
      endsAt: NOW + 2 * HOUR + 14 * DAY,
      recurrence: ["RRULE:FREQ=WEEKLY;WKST=MO", "EXDATE:20261117T100000Z"],
    })
    expect(writer.held("primary").find(({ externalId }) => externalId === id)?.participants).toEqual([
      { email: "ana@example.com", optional: true },
    ])
  })

  it("on the series' first occurrence it changes the whole series", async () => {
    const { cli, writer, opening } = await withWeekly({ permissions: SPLIT })
    await cli("events", "update", opening, "--following", "--title", "Renamed", "--no-notify")
    expect(writer.calls).toEqual([expect.objectContaining({ write: "update", externalId: "w1", scope: "series" })])
  })

  it("refuses a COUNT series without a rule for the new part, and --series with --following", async () => {
    const { cli, writer, store, slot } = await withWeekly({ permissions: SPLIT })
    await store.saveEntries(1, writer.put("primary", { ...weekly, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=5"] }), NOW)
    await expect(cli("events", "update", slot, "--following", "--title", "x", "--no-notify")).rejects.toMatchObject({
      details: { reason: "event.repeat-count" },
    })
    await expect(
      cli("events", "update", slot, "--following", "--series", "--title", "x", "--no-notify"),
    ).rejects.toMatchObject({ details: { param: "--following" } })
    const answer = await cli(
      "events",
      "update",
      slot,
      "--following",
      "--title",
      "x",
      "--repeat",
      "FREQ=WEEKLY;COUNT=3",
      "--no-notify",
    )
    expect((await store.entry(1, "w1"))?.recurrence?.[0]).toBe("RRULE:FREQ=WEEKLY;UNTIL=20261110T095959Z")
    expect((await store.entry(1, answer.operation_id as string))?.recurrence?.[0]).toBe("RRULE:FREQ=WEEKLY;COUNT=3")
  })

  it("a conflict on the old series after the new one is made names the id; the retry finds it and ends the old", async () => {
    const { cli, writer, store, slot } = await withWeekly({ permissions: SPLIT })
    const update = writer.update
    writer.update = async (...args) => {
      writer.changeBehind("primary", "w1")
      writer.update = update
      return update(...args)
    }
    const failed = await cli("events", "update", slot, "--following", "--title", "New", "--no-notify").catch(
      (error) => error,
    )
    expect(failed).toMatchObject({ details: { reason: "event.conflict" } })
    const id = failed.details.operation_id as string
    expect(failed.message).toContain(`--operation-id ${id}`)
    await store.saveEntries(
      1,
      writer.held("primary").filter(({ externalId }) => externalId === "w1"),
      NOW,
    )
    await cli("events", "update", slot, "--following", "--title", "New", "--no-notify", "--operation-id", id)
    expect(writer.held("primary").filter(({ title }) => title === "New")).toHaveLength(1)
    expect((await store.entry(1, "w1"))?.recurrence?.[0]).toContain("UNTIL=20261110T095959Z")
    await expect(cli("events", "update", slot, "--following", "--title", "New", "--no-notify")).rejects.toMatchObject({
      details: { reason: "event.repeat-split" },
    })
  })

  it("a lost answer on the old series says to sync first, since the split may be done", async () => {
    const { cli, writer, slot } = await withWeekly({ permissions: SPLIT })
    const update = writer.update
    writer.update = async (...args) => {
      writer.update = update
      writer.loseNextAnswer()
      return update(...args)
    }
    const lost = await cli("events", "update", slot, "--following", "--title", "New", "--no-notify").catch(
      (error) => error,
    )
    expect(lost).toMatchObject({ code: "outcome_unknown" })
    expect(lost.message).toContain("sync: if the series now ends before this occurrence, the split is done")
    expect(lost.message).toContain(`--operation-id ${lost.details.operation_id}`)
    expect(writer.held("primary").find(({ externalId }) => externalId === "w1")?.recurrence?.[0]).toContain("UNTIL=")
  })

  it("delete --following ends the series and asks first, as deleting one event does", async () => {
    const { cli, store, slot } = await withWeekly()
    await expect(cli("events", "delete", slot, "--following", "--no-notify")).rejects.toMatchObject({
      code: "confirmation_required",
    })
    const allowed = await withWeekly({ permissions: SPLIT })
    const answer = await allowed.cli("events", "delete", allowed.slot, "--following", "--no-notify")
    expect(answer).toMatchObject({ scope: "following", removed: 1 })
    expect((await allowed.store.entry(1, "w1"))?.recurrence?.[0]).toBe(
      "RRULE:FREQ=WEEKLY;WKST=MO;UNTIL=20261110T095959Z",
    )
    expect((await store.entry(1, "w1"))?.recurrence?.[0]).toBe("RRULE:FREQ=WEEKLY;WKST=MO")
  })
})

describe("events move", () => {
  const MOVE: Record<string, Level> = { ...ALLOW, "events.move": "allow" }

  it("moves the event with its id; the store holds one live copy, on the new calendar, of the same event", async () => {
    const { cli, writer, store, eventOf } = await setup({ permissions: MOVE })
    const event = await eventOf("e1")
    const answer = await cli("events", "move", `event:${event}`, "--to-calendar", "family", "--no-notify")
    expect(answer).toMatchObject({ from_calendar: "1", calendar: "2", event: `event:${event}` })
    expect(answer).not.toHaveProperty("hint")
    expect(writer.calls.at(-1)).toMatchObject({ write: "move", externalId: "e1", target: "family", notify: false })
    const details = await store.event(event)
    expect(details?.entries.filter(({ status }) => status !== "cancelled").map(({ calendarId }) => calendarId)).toEqual(
      [2],
    )
  })

  it("goes ahead by default, needs --notify or --no-notify with other attendees, and asks when the owner set it", async () => {
    const { cli, eventOf, writer } = await setup()
    const event = `event:${await eventOf("e1")}`
    await expect(cli("events", "move", event, "--to-calendar", "family")).rejects.toMatchObject({
      details: { reason: "event.notify-required" },
    })
    await cli("events", "move", event, "--to-calendar", "family", "--no-notify")
    expect(writer.calls.at(-1)).toMatchObject({ write: "move" })
    const asking = await setup({ permissions: { "events.move": "ask" } })
    await expect(
      asking.cli("events", "move", `event:${await asking.eventOf("e1")}`, "--to-calendar", "family", "--no-notify"),
    ).rejects.toMatchObject({ code: "confirmation_required" })
  })

  it("refuses the same calendar, a calendar it cannot write, one of another account, and a lone occurrence", async () => {
    const { cli, eventOf } = await withWeekly({ permissions: MOVE })
    const event = `event:${await eventOf("e1")}`
    const move = (...args: string[]) => cli("events", "move", ...args, "--no-notify")
    await expect(move(event, "--to-calendar", "primary")).rejects.toMatchObject({ code: "validation_error" })
    await expect(move(event, "--to-calendar", "holidays")).rejects.toMatchObject({
      details: { reason: "calendar.read-only" },
    })
    await expect(move(event, "--to-calendar", "someone@example.com")).rejects.toMatchObject({ code: "not_found" })
    const slot = `event:${await eventOf("w1_3")}`
    await expect(move(slot, "--to-calendar", "family")).rejects.toMatchObject({ details: { param: "--series" } })
    await move(slot, "--to-calendar", "family", "--series")
  })

  it("is not offered for a writer that cannot move", async () => {
    const { program, writer } = await setup()
    delete (writer as { move?: unknown }).move
    const events = program().commands.find((one) => one.name() === "events")
    expect(events?.commands.map((one) => one.name())).not.toContain("move")
  })
})
