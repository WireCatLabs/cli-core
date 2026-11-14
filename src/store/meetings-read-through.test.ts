import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { addMeetingCommands } from "../meetings/cli/index.js"
import {
  createMeetingManagement,
  type FoundMeeting,
  type MeetingSource,
  type MeetingTerm,
  type MeetingWindow,
  meetingsListThrough,
  saveSourceMeeting,
} from "../meetings/index.js"
import { fakeMeetingSource } from "../meetings/testing/index.js"
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

const fixture = async (source?: MeetingSource) => {
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
    program.option("--offline").option("--dry-run")
    addMeetingCommands(program, {
      store: store.meetings,
      ...(source ? { source } : {}),
      accountId,
      write: (value) => answers.push(value),
      inRun: (_command, body) => body(),
      now: () => NOW,
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
    expect(again.server).toEqual({ backend: "both", skipped: null, calls: 1, returned: 2, new: 0, complete: true })
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
    expect(capped.meta).toEqual({ truncated: true })

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
        accountId: 1,
        management,
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
