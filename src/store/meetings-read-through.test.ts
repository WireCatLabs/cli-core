import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { askBeforeWrite } from "../cli/ask-before-write.js"
import { inCommandRun, outputFor } from "../cli/context.js"
import { itemOf, renderAnswer } from "../cli/envelope.js"
import { commandPermissions } from "../cli/permission-keys.js"
import { type ProgramDefinition, run as runProgram } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import { addMeetingCommands, type MeetingCommandDeps } from "../meetings/cli/index.js"
import {
  createMeetingManagement,
  type FoundMeeting,
  type MeetingSource,
  type MeetingTerm,
  type MeetingWindow,
  meetingsListThrough,
  saveSourceMeeting,
} from "../meetings/index.js"
import { fakeMeetingSource, flagPaging } from "../meetings/testing/index.js"
import type { AppIdentity } from "../ports/app.js"
import { DEFAULT_PERMISSIONS } from "../sends/permissions.js"
import { openStore } from "./store.js"

const NOW = Date.parse("2026-11-14T12:00:00Z")
const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const found = (id: string, title: string, startedAt: string): FoundMeeting => ({
  meeting: { series: null, occurrence: { id, seriesId: id, title, startedAt, endedAt: null } },
  participants: [
    {
      identityExternalId: null,
      email: "ana@example.com",
      displayName: "Ana Example",
      externalId: null,
      role: null,
      joinedAt: null,
      leftAt: null,
      durationMs: null,
      sessions: null,
      metadata: null,
    },
  ],
})
const ROADMAP = found("svc-1", "Example roadmap review", "2026-11-10T10:00:00Z")
const WEEKLY = found("both-1", "Example weekly sync", "2026-11-11T10:00:00Z")
const LOCAL = found("store-1", "Example retro", "2026-11-12T10:00:00Z")

interface Asked {
  window: MeetingWindow
  terms: MeetingTerm[]
  cursor: string | null
}

const serviceOf = (
  meetings: FoundMeeting[],
  overrides: Partial<MeetingSource> & { pageSize?: number; fail?: unknown } = {},
) => {
  const asked: Asked[] = []
  const got: string[] = []
  const { pageSize = 100, fail, ...rest } = overrides
  const source = fakeMeetingSource({
    name: "Example Meet",
    finds: { fields: { provider_id: ["term"] } },
    async meetings() {
      return meetings.map(({ meeting }) => meeting)
    },
    async participants(id) {
      return meetings.find(({ meeting }) => meeting.occurrence.id === id)?.participants ?? null
    },
    async find(window, terms, cursor) {
      asked.push({ window, terms: [...terms], cursor })
      if (fail) throw fail
      const fits = meetings.filter(({ meeting }) => {
        const at = Date.parse(meeting.occurrence.startedAt)
        return (
          (window.from === undefined || at >= window.from) &&
          (window.to === undefined || at <= window.to) &&
          terms.every(({ predicate, negated }) => (meeting.occurrence.id === predicate.value) !== negated)
        )
      })
      const start = cursor === null ? 0 : Number(cursor)
      const next = start + pageSize < fits.length ? String(start + pageSize) : null
      return { meetings: fits.slice(start, start + pageSize), next }
    },
    async get(id) {
      got.push(id)
      if (fail) throw fail
      const one = [...meetings, found("svc-9", "Example planning", "2026-11-09T09:00:00Z")].find(
        ({ meeting }) => meeting.occurrence.id === id,
      )
      return one
        ? {
            ...one,
            transcript: [{ startMs: 0, endMs: 1000, speaker: "Ana Example", text: "Ship the example plan." }],
            documents: [{ fileId: "drive-file-1", role: "transcript" as const, title: "Example planning transcript" }],
          }
        : null
    },
    ...rest,
  })
  return { source, asked, got }
}

const fixture = async (source?: MeetingSource, extra: Partial<MeetingCommandDeps> = {}) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "meetings-read-through-")), "store.db") })
  handles.push(store)
  const accountId = await store.accounts.saveAccount({ provider: "example", account: "invented" }, { name: "Invented" })
  const keep = (one: FoundMeeting) =>
    saveSourceMeeting(
      fakeMeetingSource(),
      store.meetings,
      one.meeting,
      { participants: one.participants },
      {
        accountId,
        now: NOW,
      },
    )
  const answers: unknown[] = []
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} })
    program.option("--offline").option("--dry-run").option("--json")
    addMeetingCommands(program, {
      store: store.meetings,
      ...(source ? { source } : {}),
      pagingOf: flagPaging,
      accountId,
      write: (value) => answers.push(value),
      inRun: (_command, body) => body(),
      now: () => NOW,
      ...extra,
    })
    const offline = args[0] === "--offline" ? [args.shift() as string] : []
    await program.parseAsync([...offline, "meetings", ...args], { from: "user" })
    return answers.at(-1) as Record<string, unknown> & { items: Record<string, unknown>[] }
  }
  return { store, accountId, keep, run }
}

const titles = (answer: { items: Record<string, unknown>[] }) =>
  answer.items.map(({ title, found_in }) => [title, found_in])

describe("meetings list reads the service and the store at once", () => {
  it("reads a start date in the meetings zone and names that zone in meta.timezone", async () => {
    const { run, keep } = await fixture(undefined, { timezone: "Pacific/Kiritimati" })
    await keep(LOCAL)
    const dated = await run("--offline", "list", "started_at:2026-11-13", "--json")
    expect([titles(dated), dated.meta]).toEqual([[["Example retro", "archive"]], { timezone: "Pacific/Kiritimati" }])
    expect((await run("--offline", "list", "started_at:2026-11-12", "--json")).items).toEqual([])
    expect((await run("--offline", "list", "started_at>2d", "--json")).meta).toBeUndefined()
  })

  it("answers one list: service-only, store-only and shared meetings, each once, with where it was found", async () => {
    const { source } = serviceOf([ROADMAP, WEEKLY])
    const { store, accountId, keep, run } = await fixture(source)
    await keep(WEEKLY)
    await keep(LOCAL)
    const answer = await run("list", "--json")
    expect(titles(answer)).toEqual([
      ["Example retro", "archive"],
      ["Example weekly sync", "both"],
      ["Example roadmap review", "server"],
    ])
    expect(answer.missing).toBeUndefined()
    expect(answer).not.toHaveProperty("server")
    const again = await meetingsListThrough(source, store.meetings, { accountId }, { now: NOW })
    expect(again.server).toEqual({
      backend: "both",
      skipped: null,
      calls: 1,
      returned: 2,
      new: 0,
      failed: 0,
      complete: true,
    })
    expect(await store.meetings.meetings({ accountId })).toHaveLength(3)
    expect(answer.items.find(({ title }) => title === "Example roadmap review")).toMatchObject({
      provider_id: "svc-1",
      participants_count: 1,
    })
  })

  it("keeps the row sync writes, whichever comes first", async () => {
    const { source } = serviceOf([ROADMAP])
    const listedFirst = await fixture(source)
    await listedFirst.run("list")
    await listedFirst.run("sync", "--since-time", "2026-11-01T00:00:00Z")
    const syncedFirst = await fixture(source)
    await syncedFirst.run("sync", "--since-time", "2026-11-01T00:00:00Z")
    const answer = await syncedFirst.run("list")
    for (const { store, accountId } of [listedFirst, syncedFirst])
      expect((await store.meetings.meetings({ accountId })).map(({ externalId }) => externalId)).toEqual(["svc-1"])
    expect(titles(answer)).toEqual([["Example roadmap review", "both"]])
  })

  it("never moves the sync's cursor", async () => {
    const { source } = serviceOf([ROADMAP])
    const { store, accountId, run } = await fixture(source)
    await run("list")
    expect(await store.meetings.cursor(accountId)).toBeNull()
  })

  it("asks the service with what it can filter and lets the store decide the rest", async () => {
    const { source, asked } = serviceOf([ROADMAP, WEEKLY])
    const { run } = await fixture(source)
    const answer = await run(
      "list",
      'title:*roadmap* AND started_at:["2026-11-01T00:00:00Z" TO "2026-11-30T23:59:59Z"]',
    )
    expect(asked).toEqual([
      {
        window: { from: Date.parse("2026-11-01T00:00:00Z"), to: Date.parse("2026-11-30T23:59:59Z") },
        terms: [],
        cursor: null,
      },
    ])
    expect(titles(answer)).toEqual([["Example roadmap review", "server"]])
  })

  it("asks one call per OR branch and sends a NOT only where the service can negate", async () => {
    const or = serviceOf([ROADMAP, WEEKLY])
    const answer = await (await fixture(or.source)).run("list", "provider_id:svc-1", "OR", "provider_id:both-1")
    expect(or.asked.map(({ terms }) => terms.map(({ predicate }) => predicate.value))).toEqual([["svc-1"], ["both-1"]])
    expect(answer.items).toHaveLength(2)

    const plain = serviceOf([ROADMAP, WEEKLY])
    const kept = await (await fixture(plain.source)).run("list", "NOT", "provider_id:svc-1")
    expect(plain.asked.map(({ terms }) => terms)).toEqual([[]])
    expect(titles(kept)).toEqual([["Example weekly sync", "server"]])

    const negating = serviceOf([ROADMAP, WEEKLY], {
      finds: { fields: { provider_id: ["term"] }, negatable: ["provider_id"] },
    })
    await (await fixture(negating.source)).run("list", "NOT", "provider_id:svc-1")
    expect(negating.asked[0]?.terms).toMatchObject([
      { predicate: { field: "provider_id", value: "svc-1" }, negated: true },
    ])
  })

  it("says the answer is not complete past the call cap or the page cap", async () => {
    const many = serviceOf([ROADMAP, WEEKLY])
    const capped = await (await fixture(many.source)).run(
      "list",
      ...["provider_id:a OR provider_id:b OR provider_id:c OR provider_id:d"],
    )
    expect(many.asked).toHaveLength(3)
    expect(capped.missing).toEqual([{ field: "server", why: expect.stringContaining("asked 3 time(s)") }])
    expect(capped.meta).toEqual({
      complete: false,
      issues: [{ code: "outcome_unknown", reason: "meetings.server-capped", source: "Example Meet" }],
    })

    const paged = serviceOf([ROADMAP, WEEKLY, LOCAL], { pageSize: 1 })
    const answer = await (await fixture(paged.source)).run("list")
    expect(paged.asked.map(({ cursor }) => cursor)).toEqual([null, "1"])
    expect(answer.missing).toEqual([
      { field: "server", why: expect.stringContaining("asked 2 time(s) and returned 2 meeting(s)") },
    ])
  })

  it("answers from the store, saying why, offline or signed out; a typed --backend server refuses", async () => {
    const offline = serviceOf([ROADMAP])
    const quiet = await fixture(offline.source)
    await quiet.keep(LOCAL)
    const answer = await quiet.run("--offline", "list")
    expect(offline.asked).toHaveLength(0)
    expect(titles(answer)).toEqual([["Example retro", "archive"]])
    expect(answer.missing).toEqual([{ field: "server", why: expect.stringContaining("--offline") }])
    expect(answer.meta).toEqual({
      complete: false,
      issues: [{ code: "permission_error", reason: "meetings.server-offline", source: "Example Meet" }],
    })

    const signedOut = serviceOf([ROADMAP], { fail: new CliError("authentication_error", "sign in first") })
    const out = await fixture(signedOut.source)
    await out.keep(LOCAL)
    const fallback = await out.run("list")
    expect(titles(fallback)).toEqual([["Example retro", "archive"]])
    expect(fallback.missing).toEqual([{ field: "server", why: expect.stringContaining("not signed in") }])
    expect(fallback.meta).toMatchObject({ complete: false, issues: [{ reason: "meetings.server-signed-out" }] })
    await expect(out.run("list", "--backend", "server")).rejects.toMatchObject({ code: "authentication_error" })
    await expect(quiet.run("--offline", "list", "--backend", "server")).rejects.toMatchObject({
      code: "validation_error",
    })
  })

  it("reads only the store with --backend archive and only the service's meetings with --backend server", async () => {
    const { source, asked } = serviceOf([ROADMAP])
    const { keep, run } = await fixture(source)
    await keep(LOCAL)
    const stored = await run("list", "--backend", "archive")
    expect(asked).toHaveLength(0)
    expect(stored.items.map(({ title, found_in }) => [title, found_in])).toEqual([["Example retro", undefined]])
    expect(stored.missing).toBeUndefined()
    expect(titles(await run("list", "--backend", "server"))).toEqual([["Example roadmap review", "server"]])
  })

  it("names what a source without find cannot answer, and refuses --backend server", async () => {
    const { keep, run } = await fixture(fakeMeetingSource())
    await keep(LOCAL)
    const answer = await run("list")
    expect(titles(answer)).toEqual([["Example retro", "archive"]])
    expect(answer.missing).toEqual([{ field: "server", why: expect.stringContaining("cannot be asked") }])
    expect(answer.meta).toBeUndefined()
    await expect(run("list", "--backend", "server")).rejects.toMatchObject({ code: "validation_error" })
  })

  it("says so when a service that lists no upcoming meeting is asked for one", async () => {
    const { source, asked } = serviceOf([ROADMAP], {
      finds: { fields: { provider_id: ["term"] }, upcoming: false },
    })
    const { run } = await fixture(source)
    const answer = await run("list", "started_at>0m")
    expect(asked).toHaveLength(0)
    expect(answer.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "upcoming" }),
        expect.objectContaining({ field: "server" }),
      ]),
    )
    await run("list", 'started_at>="2026-11-01T00:00:00Z"')
    expect(asked.at(-1)?.window).toEqual({ from: Date.parse("2026-11-01T00:00:00Z"), to: NOW })
  })
})

describe("what a live read keeps, and what it says it could not read", () => {
  it("reads a day in the owner's zone on both sides: the service's window and the store's query", async () => {
    // 00:30 on 10 November in Madrid is still 9 November in UTC.
    const late = found("late-1", "Example late call", "2026-11-09T23:30:00Z")
    const { source, asked } = serviceOf([late])
    const { run } = await fixture(source, { timezone: "Europe/Madrid" })
    const answer = await run("list", "started_at:2026-11-10")
    expect(asked[0]?.window).toEqual({
      from: Date.parse("2026-11-09T23:00:00Z"),
      to: Date.parse("2026-11-10T22:59:59.999Z"),
    })
    expect(titles(answer)).toEqual([["Example late call", "server"]])
  })

  it("keeps what sync stored when the list's record of a meeting is thinner", async () => {
    const occurrence = {
      id: "x-1",
      seriesId: "x-1",
      title: "Example review",
      startedAt: "2026-11-09T10:00:00Z",
      endedAt: "2026-11-09T11:00:00Z",
    }
    const series = { id: "series-x", provider: "example", title: "Example reviews" }
    const full: FoundMeeting = {
      meeting: { series, description: "Example agenda", metadata: { issues: ["time_without_zone"] }, occurrence },
      participants: found("x-1", "Example review", occurrence.startedAt).participants,
    }
    const { source } = serviceOf([
      { meeting: { series: null, occurrence: { ...occurrence, endedAt: null } }, participants: null },
    ])
    const { store, accountId, run } = await fixture(source)
    await saveSourceMeeting(
      fakeMeetingSource(),
      store.meetings,
      full.meeting,
      {
        participants: full.participants,
        summary: { title: null, overview: "Example notes", sections: [], nextSteps: [] },
      },
      { accountId, now: NOW },
    )
    const answer = await run("list", "duration_ms>=3600000")
    expect(titles(answer)).toEqual([["Example review", "both"]])
    const kept = await store.meetings.meetingByExternalId?.(accountId, "x-1")
    expect(kept?.meeting).toMatchObject({
      endedAt: Date.parse("2026-11-09T11:00:00Z"),
      description: "Example agenda",
      metadata: { issues: ["time_without_zone"] },
      participantsCount: 1,
    })
    expect(kept?.series?.externalId).toBe("series-x")
    expect(kept?.participants).toHaveLength(1)
    expect(kept?.summaries).toHaveLength(1)
  })

  it("writes nothing when the service returns a stored meeting unchanged", async () => {
    const { source } = serviceOf([ROADMAP])
    const { store, accountId, run } = await fixture(source)
    const earlier = NOW - 60_000
    await saveSourceMeeting(
      fakeMeetingSource(),
      store.meetings,
      ROADMAP.meeting,
      { participants: ROADMAP.participants },
      {
        accountId,
        now: earlier,
      },
    )
    expect(titles(await run("list"))).toEqual([["Example roadmap review", "both"]])
    expect((await store.meetings.meetingByExternalId?.(accountId, "svc-1"))?.meeting.updatedAt).toBe(earlier)
  })

  it("answers --backend server when the service returns more meetings than one SQL expression holds", async () => {
    const many = Array.from({ length: 1200 }, (_, i) =>
      found(`m-${i}`, `Example ${i}`, new Date(NOW - (i + 1) * 3_600_000).toISOString()),
    )
    const { source } = serviceOf(many, { pageSize: 600 })
    const { run } = await fixture(source)
    const answer = await run("list", "--backend", "server", "--limit", "5")
    expect(answer.items).toHaveLength(5)
  })

  it("counts a meeting it could not keep and says why, apart from the call cap", async () => {
    const broken = found("bad-1", "Example broken", "2026-11-10T10:00:00Z")
    const { source } = serviceOf([
      {
        ...broken,
        meeting: { ...broken.meeting, occurrence: { ...broken.meeting.occurrence, endedAt: "2026-11-10T09:00:00Z" } },
      },
      ROADMAP,
    ])
    const answer = await (await fixture(source)).run("list")
    expect(titles(answer)).toEqual([["Example roadmap review", "server"]])
    expect(answer.missing).toEqual([
      { field: "server", why: expect.stringContaining("1 meeting(s) Example Meet returned could not be kept") },
    ])
    expect(answer.meta).toEqual({
      complete: false,
      issues: [{ code: "provider_error", reason: "meetings.server-failed", source: "Example Meet" }],
    })
  })

  it("names a network failure as one, not as --offline", async () => {
    const { source } = serviceOf([ROADMAP], { fail: new CliError("network_error", "connection reset") })
    const answer = await (await fixture(source)).run("list")
    expect(answer.missing).toEqual([{ field: "server", why: expect.stringContaining("could not be reached") }])
    expect(answer.meta).toEqual({
      complete: false,
      issues: [{ code: "network_error", reason: "meetings.server-unreachable", source: "Example Meet" }],
    })
  })

  it("says a plain list leaves out upcoming meetings of a service that lists none before they start", async () => {
    const { source, asked } = serviceOf([ROADMAP], { finds: { fields: {}, upcoming: false } })
    const answer = await (await fixture(source)).run("list")
    expect(asked[0]?.window).toEqual({ to: NOW })
    expect(answer.missing).toEqual([expect.objectContaining({ field: "upcoming" })])
  })

  it("marks the service's text untrusted", async () => {
    const { source } = serviceOf([ROADMAP])
    const answer = await (await fixture(source)).run("list")
    expect(answer.items[0]?.untrusted).toEqual(["title", "description", "location"])
  })
})

describe("meetings show reads the meeting again from the service", () => {
  it("shows by the service's id a meeting not stored yet, and keeps its transcript and documents", async () => {
    const { source, got } = serviceOf([])
    const { store, accountId, run } = await fixture(source)
    const answer = (await run("show", "svc-9", "--json")) as unknown as { item: Record<string, unknown> }
    expect(got).toEqual(["svc-9"])
    expect(answer.item).toMatchObject({ provider_id: "svc-9", title: "Example planning", found_in: "server" })
    expect(answer.item.transcripts).toHaveLength(1)
    const kept = await store.meetings.meetingByExternalId?.(accountId, "svc-9")
    expect(kept?.documents).toMatchObject([{ fileId: "drive-file-1", role: "transcript" }])
    const again = (await run("show", String(kept?.meeting.id))) as unknown as { item: Record<string, unknown> }
    expect(again.item).toMatchObject({ provider_id: "svc-9", found_in: "both" })
    expect(got).toEqual(["svc-9", "svc-9"])
  })

  it("takes the meeting: ref, answers from the store when offline, and refuses an unknown id", async () => {
    const { source, got } = serviceOf([ROADMAP])
    const { keep, run } = await fixture(source)
    const details = await keep(ROADMAP)
    const ref = `meeting:${details.meeting.accountId}/${details.meeting.id}`
    const offline = (await run("--offline", "show", ref)) as unknown as Record<string, unknown>
    expect(got).toHaveLength(0)
    expect(offline).toMatchObject({
      item: { found_in: "archive" },
      missing: [{ field: "server", why: expect.stringContaining("--offline") }],
    })
    await expect(run("show", "nobody-knows")).rejects.toMatchObject({ code: "not_found" })
    await expect(run("show", ref, "--backend", "archive")).resolves.toMatchObject({ item: { provider_id: "svc-1" } })
  })
})

describe("meetings create, update and cancel", () => {
  it("are mounted for the ports a host has, preview under --dry-run, and ask first by default", async () => {
    const changes: string[] = []
    const management = createMeetingManagement(
      { provider: "example", account: "invented" },
      {
        async create(change) {
          changes.push(`create ${change.title}`)
          return {
            id: "900",
            title: change.title ?? null,
            kind: "scheduled",
            startTime: change.startTime ?? null,
            durationMinutes: null,
            timezone: null,
            agenda: null,
            joinUrl: "https://example.com/j/900",
          }
        },
        async cancel(id) {
          changes.push(`cancel ${id}`)
        },
      },
    )
    const answers: unknown[] = []
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "meetings-management-")), "store.db") })
    handles.push(store)
    const programOf = () => {
      const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} })
      program.option("--dry-run")
      addMeetingCommands(program, {
        store: store.meetings,
        pagingOf: flagPaging,
        accountId: 1,
        management,
        askFirst: async () => {},
        write: (value) => answers.push(value),
        inRun: (_command, body) => body(),
      })
      return program
    }
    const meetings = programOf().commands.find((command) => command.name() === "meetings")
    expect(meetings?.commands.map((command) => command.name())).toEqual(expect.arrayContaining(["create", "cancel"]))
    expect(meetings?.commands.map((command) => command.name())).not.toContain("update")
    const args = ["meetings", "create", "--title", "Example planning", "--start-time", "2026-11-20T10:00:00Z"]
    await programOf().parseAsync(["--dry-run", ...args], { from: "user" })
    expect(changes).toEqual([])
    expect(answers.at(-1)).toMatchObject({ item: { action: "create", applied: false } })
    await programOf().parseAsync(args, { from: "user" })
    expect(answers.at(-1)).toMatchObject({
      item: { action: "create", applied: true, meeting: { id: "900", join_url: "https://example.com/j/900" } },
    })
    await programOf().parseAsync(["meetings", "cancel", "900"], { from: "user" })
    expect(changes).toEqual(["create Example planning", "cancel 900"])
    expect(DEFAULT_PERMISSIONS).toMatchObject({
      "meetings.create": "ask",
      "meetings.update": "ask",
      "meetings.cancel": "ask",
    })
  })
})

const MEET_SETTINGS = [
  {
    name: "access_type",
    description: "who joins without asking",
    type: "choice",
    values: ["open", "trusted", "restricted"],
  },
  { name: "moderation", description: "only hosts manage the call", type: "boolean" },
  { name: "label", description: "a label for the space", type: "text" },
] as const

const meetingRow = {
  id: "900",
  title: null,
  kind: null,
  startTime: null,
  durationMinutes: null,
  timezone: null,
  agenda: null,
  joinUrl: null,
}

/** A service like Google Meet: a space has no title or time, its changes are settings, and it cannot be deleted. */
const meetLike = () => {
  const calls: unknown[] = []
  const management = createMeetingManagement(
    { provider: "example-meet", account: "invented" },
    {
      async create(change) {
        calls.push(["create", change])
        return {
          id: "spaces/abc",
          title: null,
          kind: "instant",
          startTime: change.startTime ?? null,
          durationMinutes: null,
          timezone: null,
          agenda: null,
          joinUrl: "https://example.com/abc-defg-hij",
        }
      },
      async update(id, change) {
        calls.push(["update", id, change])
      },
      fields: {
        create: { fields: [], settings: MEET_SETTINGS },
        update: { fields: [], settings: MEET_SETTINGS },
      },
    },
    { now: () => NOW },
  )
  return { calls, management }
}

describe("meetings create and update take what the service declares", () => {
  const programWith = async (management: ReturnType<typeof meetLike>["management"]) => {
    const answers: unknown[] = []
    let asked = 0
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "meetings-fields-")), "store.db") })
    handles.push(store)
    const program = () => {
      const root = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} })
      root.option("--dry-run")
      addMeetingCommands(root, {
        store: store.meetings,
        accountId: 1,
        management,
        askFirst: async () => {
          asked++
        },
        write: (value) => answers.push(value),
        inRun: (_command, body) => body(),
      })
      return root
    }
    const run = async (...words: string[]) => {
      await program().parseAsync(words, { from: "user" })
      return answers.at(-1)
    }
    return { run, program, asked: () => asked }
  }

  it("creates with no title and no time: the meeting starts now", async () => {
    const { calls, management } = meetLike()
    const { run, asked } = await programWith(management)
    expect(await run("meetings", "create", "--setting", "access_type=trusted")).toEqual({
      item: {
        action: "create",
        provider: "example-meet",
        account: "invented",
        change: { kind: "instant", start_time: "2026-11-14T12:00:00.000Z", settings: { access_type: "trusted" } },
        applied: true,
        meeting: {
          id: "spaces/abc",
          title: null,
          kind: "instant",
          start_time: "2026-11-14T12:00:00.000Z",
          duration_minutes: null,
          timezone: null,
          agenda: null,
          join_url: "https://example.com/abc-defg-hij",
        },
        untrusted: ["meeting.title", "meeting.agenda", "meeting.join_url"],
      },
    })
    expect(asked()).toBe(1)
    expect(calls).toEqual([
      ["create", { kind: "instant", startTime: "2026-11-14T12:00:00.000Z", settings: { access_type: "trusted" } }],
    ])
  })

  it("updates the declared settings, typed as declared", async () => {
    const { calls, management } = meetLike()
    const { run } = await programWith(management)
    const args = ["meetings", "update", "spaces/abc", "--setting", "access_type=restricted", "--setting"]
    await run(...args, "moderation=true")
    expect(calls).toEqual([["update", "spaces/abc", { settings: { access_type: "restricted", moderation: true } }]])
  })

  it("refuses what the service does not take, naming what it does, before asking the owner", async () => {
    const { calls, management } = meetLike()
    const { run, asked } = await programWith(management)
    await expect(run("meetings", "update", "spaces/abc", "--title", "Example planning")).rejects.toMatchObject({
      code: "validation_error",
      message:
        "this service does not take --title on update; it takes --setting access_type, --setting moderation, --setting label",
    })
    await expect(run("meetings", "update", "spaces/abc", "--setting", "recording=on")).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("does not take --setting recording"),
    })
    await expect(run("meetings", "create", "--setting", "access_type=closed")).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("one of open, trusted, restricted"),
    })
    await expect(
      run("meetings", "update", "spaces/abc", "--setting", "moderation=true", "--setting", "moderation=false"),
    ).rejects.toMatchObject({ code: "validation_error", message: "--setting moderation is given twice" })
    expect(asked()).toBe(0)
    expect(calls).toEqual([])
  })

  it("lists the service's settings and the fields it takes in the commands document and the help", async () => {
    const { management } = meetLike()
    const { program } = await programWith(management)
    const document = JSON.stringify(describeProgram(program()))
    expect(document).toContain(
      "a setting of this service; repeat it for more: access_type=open|trusted|restricted, moderation=true|false, label=<text>",
    )
    const create = program()
      .commands.find((command) => command.name() === "meetings")
      ?.commands.find((command) => command.name() === "create")
    const help: string[] = []
    create?.configureOutput({ writeOut: (text) => help.push(text) }).outputHelp()
    expect(help.join("").replace(/\s+/g, " ")).toContain("this service takes none, its meetings start now")
    expect(help.join("")).toContain("This service takes none of the options above.")
    expect(help.join("")).toContain("  access_type=open|trusted|restricted  who joins without asking")
  })

  it("reads --setting as a snake_case name and the rest after the first =", async () => {
    const { calls, management } = meetLike()
    const { run, asked } = await programWith(management)
    await run("meetings", "update", "spaces/abc", "--setting", "label=b=c")
    expect(calls).toEqual([["update", "spaces/abc", { settings: { label: "b=c" } }]])
    for (const wrong of ["=x", "x", "__proto__=x", "Label=x"])
      await expect(run("meetings", "update", "spaces/abc", "--setting", wrong)).rejects.toMatchObject({
        code: "commander.invalidArgument",
      })
    await expect(run("meetings", "update", "spaces/abc", "--setting", "label=")).rejects.toMatchObject({
      code: "validation_error",
      message: "meeting setting label must be nonempty text: this service cannot clear it",
    })
    expect(calls).toHaveLength(1)
    expect(asked()).toBe(1)
  })

  it("refuses a create with no start on a service that can schedule, before asking", async () => {
    const created: unknown[] = []
    const zoomLike = createMeetingManagement(
      { provider: "example-zoom", account: "invented" },
      {
        async create(change) {
          created.push(change)
          return { ...meetingRow, id: "901" }
        },
      },
      { now: () => NOW },
    )
    const { run, asked } = await programWith(zoomLike)
    await expect(run("meetings", "create", "--title", "Example planning")).rejects.toMatchObject({
      code: "validation_error",
      message: "give --start-time, or --kind instant for a meeting that starts now",
    })
    expect(asked()).toBe(0)
    expect(await run("meetings", "create", "--kind", "instant")).toMatchObject({
      item: { change: { kind: "instant", start_time: "2026-11-14T12:00:00.000Z" }, applied: true },
    })
    expect(created).toEqual([{ kind: "instant", startTime: "2026-11-14T12:00:00.000Z" }])
  })

  it("mounts no cancel for a service that cannot delete, and --dry-run reaches nothing", async () => {
    const { calls, management } = meetLike()
    const { run, program, asked } = await programWith(management)
    const meetings = program().commands.find((command) => command.name() === "meetings")
    expect(meetings?.commands.map((command) => command.name())).not.toContain("cancel")
    expect(await run("--dry-run", "meetings", "create")).toMatchObject({
      item: { action: "create", applied: false, change: { kind: "instant" } },
    })
    expect(await run("--dry-run", "meetings", "update", "spaces/abc", "--setting", "moderation=false")).toMatchObject({
      item: { action: "update", applied: false, change: { settings: { moderation: false } } },
    })
    expect(asked()).toBe(0)
    expect(calls).toEqual([])
  })
})

describe("meetings invitation", () => {
  it("marks the service's invitation text untrusted", async () => {
    const management = createMeetingManagement(
      { provider: "example", account: "invented" },
      {
        async invitation(id) {
          return { id, invitation: "Join the example meeting" }
        },
      },
    )
    const answers: unknown[] = []
    const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} })
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "meetings-invitation-")), "store.db") })
    handles.push(store)
    addMeetingCommands(program, {
      store: store.meetings,
      pagingOf: flagPaging,
      accountId: 1,
      management,
      write: (value) => answers.push(value),
      inRun: (_command, body) => body(),
    })
    await program.parseAsync(["meetings", "invitation", "900"], { from: "user" })
    expect(answers.at(-1)).toEqual({
      item: { id: "900", invitation: "Join the example meeting", untrusted: ["invitation"] },
    })
  })
})

describe("meetings in a real run", () => {
  const app: AppIdentity = {
    command: "meets",
    appName: "meets-cli",
    envPrefix: "MEETS",
    description: "synthetic",
    version: "1.0.0",
    messenger: false,
  }
  const ranWith = async (
    words: string[],
    deps: Partial<MeetingCommandDeps>,
    extraEnv: NodeJS.ProcessEnv = {},
    ...flags: string[]
  ) => {
    const argv = [...flags, ...words, "--json"].filter((word, at, all) => all.indexOf(word) === at)
    const home = mkdtempSync(join(tmpdir(), "meetings-real-run-"))
    const store = await openStore({ path: join(home, "store.db") })
    handles.push(store)
    const accountId = await store.accounts.saveAccount({ provider: "example", account: "invented" }, { name: null })
    const definition: ProgramDefinition = {
      app,
      configuration: settingsFor(app, { permissions: commandPermissions() }),
      commands: () => {
        const root = new Command(app.command)
        let current: Command | undefined
        addMeetingCommands(root, {
          store: store.meetings,
          pagingOf: flagPaging,
          accountId,
          write: (value) => {
            if (!current) return
            const body = value as { items?: unknown[]; item?: unknown }
            renderAnswer(current, outputFor(current), body.items || body.item ? (value as never) : itemOf(value))
          },
          inRun: (command, body) => {
            current = command
            return inCommandRun(command, body)
          },
          now: () => NOW,
          ...deps,
        })
        return [...root.commands]
      },
    }
    const out: string[] = []
    const err: string[] = []
    const env = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: home,
      XDG_STATE_HOME: home,
      MEETS_CONFIG_DIR: join(home, "config"),
      MEETS_STATE_DIR: join(home, "state"),
      ...extraEnv,
    }
    const code = await runProgram(argv, definition, {
      env,
      tty: false,
      streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
    })
    return { code, out: out.join(""), err: err.join("") }
  }

  it("lists through the service under the read-only lock, as sync fetches under it", async () => {
    const { source, asked } = serviceOf([ROADMAP])
    const ran = await ranWith(["work", "meetings", "list", "--json"], { source }, { MEETS_READ_ONLY: "1" })
    expect(ran.code, ran.err).toBe(0)
    expect(asked).toHaveLength(1)
    expect(JSON.parse(ran.out).items).toMatchObject([{ provider_id: "svc-1", found_in: "server" }])
  })

  it("asks first by default before it creates on a service with no title or time", async () => {
    const { calls, management } = meetLike()
    const refused = await ranWith(["work", "meetings", "create", "--json"], { management, askFirst: askBeforeWrite })
    expect(refused.code).not.toBe(0)
    expect(refused.out + refused.err).toContain("confirmation_required")
    expect(calls).toEqual([])
  })

  it("refuses meetings create under the default ask when nobody can answer the question", async () => {
    const created: string[] = []
    const management = createMeetingManagement(
      { provider: "example", account: "invented" },
      {
        async create(change) {
          created.push(change.title ?? "")
          return {
            id: "901",
            title: change.title ?? null,
            kind: "scheduled",
            startTime: change.startTime ?? null,
            durationMinutes: null,
            timezone: null,
            agenda: null,
            joinUrl: null,
          }
        },
      },
    )
    const ran = await ranWith(
      ["work", "meetings", "create", "--title", "Example planning", "--start-time", "2026-11-20T10:00:00Z", "--json"],
      { management, askFirst: askBeforeWrite },
    )
    expect(created).toEqual([])
    expect(ran.code).not.toBe(0)
    expect(ran.out + ran.err).toContain("confirmation_required")
    const answered = await ranWith(
      ["work", "meetings", "create", "--title", "Example planning", "--start-time", "2026-11-20T10:00:00Z"],
      { management, askFirst: askBeforeWrite },
      {},
      "--yes",
    )
    expect(answered.code, answered.err).toBe(0)
    expect(created).toEqual(["Example planning"])
  })
})
