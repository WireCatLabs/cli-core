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
import { fakeCalendarWriter, memoryEventStore } from "../testing/index.js"
import { CALENDAR_WRITE_KEYS } from "../writer.js"
import { type CalendarWrites, createEvent, newEventId, updateEvent } from "../writes.js"
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
    return root
  }
  const parse = async (args: string[]) => {
    await program().parseAsync(args, { from: "user" })
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
          permissions: { "events.notify": "ask" as Level },
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
      names: { notify: "--notify", id: "--id", calendar: "--calendar", series: "--series" },
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
      names: { notify: "--notify", id: "--id", calendar: "--calendar", series: "--series" },
    }
    const fields = { title: "Example planning", startTime: "2026-11-02T10:00", endTime: "2026-11-02T11:00" }
    for (const id of ["example0id0w", "abcd", "ABCDEF123"])
      await expect(createEvent(context, "primary", fields, { id })).rejects.toMatchObject({ code: "validation_error" })
    expect(await createEvent(context, "primary", fields, { id: "abcdefghijklmnopqrstuv0123" })).toMatchObject({
      operation_id: "abcdefghijklmnopqrstuv0123",
    })
  })
})
