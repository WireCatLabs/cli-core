import { overrideSharedContract } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  addMeetingSearchCommand,
  createMeetingSearchCommand,
  meetingHitSearchRequest,
  validateMeetingHitSearch,
} from "./search.js"

const processZone = process.env.TZ
beforeEach(() => {
  process.env.TZ = "Europe/Madrid"
})
afterEach(() => {
  process.env.TZ = processZone
})

it("forwards combined context, dates and continuation to an injected provider-neutral search", async () => {
  const program = new Command("example")
  const controller = new AbortController()
  const result = {
    items: [
      {
        ref: "meeting:1/2/3/0",
        meetingId: 2,
        scope: "transcript" as const,
        id: 9,
        text: "the budget",
        startMs: 1500,
        source: { title: "Example review", startedAt: 1000, url: null },
      },
    ],
    hasMore: true,
    nextCursor: "next-page",
    coverage: {
      archiveCompleteness: "unknown" as const,
      currentRevisions: true as const,
      indexing: "ready" as const,
      indexCompleteness: "unknown" as const,
    },
  }
  const search = vi.fn(async () => result)
  const output = vi.fn()
  addMeetingSearchCommand(program, { search, signal: () => controller.signal, output })
  await program.parseAsync(
    [
      "search",
      "meetings",
      "budget",
      "--identity-id",
      "12",
      "--person-id",
      "34",
      "--event-id",
      "56",
      "--series-id",
      "78",
      "--project",
      "RES",
      "--topic-name",
      "costs",
      "--since-time",
      "2026-09-12",
      "--until-time",
      "2026-10-12",
      "--cursor",
      "abc",
      "--limit",
      "10",
    ],
    { from: "user" },
  )
  expect(search).toHaveBeenCalledWith(
    "budget",
    {
      participantIdentityId: 12,
      personId: 34,
      eventId: 56,
      meetingSeriesId: 78,
      project: "RES",
      topic: "costs",
      since: Date.parse("2026-09-11T22:00:00Z"),
      until: Date.parse("2026-10-12T22:00:00Z") - 1,
      after: "abc",
      limit: 10,
      signal: controller.signal,
    },
    expect.objectContaining({ eventId: 56, seriesId: 78 }),
  )
  expect(output).toHaveBeenCalledWith({
    items: [
      {
        ref: "meeting:1/2/3/0",
        meeting: "meeting:1/2",
        scope: "transcript",
        id: "9",
        excerpt: "the budget",
        offset_ms: 1500,
        untrusted: ["excerpt", "source.title"],
        source: { ref: "meeting:1/2/3/0", title: "Example review", started_at: "1970-01-01T00:00:01.000Z", url: null },
      },
    ],
    page: { mode: "cursor", limit: 10, has_more: true, next_cursor: "next-page" },
    next: [
      expect.objectContaining({
        step: "page.next",
        command: "search meetings",
        args: expect.objectContaining({
          query: "budget",
          cursor: "next-page",
          limit: 10,
          identity_id: "12",
          person_id: "34",
          event_id: "56",
          series_id: "78",
          project: "RES",
          topic_name: "costs",
          since_time: "2026-09-11T22:00:00.000Z",
          until_time: "2026-10-12T21:59:59.999Z",
          max_read_bytes: 4194304,
        }),
      }),
    ],
    meta: {
      timezone: "Europe/Madrid",
      window: { since: "2026-09-11T22:00:00.000Z", until: "2026-10-12T21:59:59.999Z" },
    },
  })
})
it("names no zone when every typed time carries its own", async () => {
  const program = new Command("example")
  const output = vi.fn()
  const search = vi.fn(async () => ({
    items: [],
    hasMore: false,
    nextCursor: null,
    coverage: {
      archiveCompleteness: "unknown" as const,
      currentRevisions: true as const,
      indexing: "ready" as const,
      indexCompleteness: "unknown" as const,
    },
  }))
  addMeetingSearchCommand(program, { search, signal: () => undefined, output })
  await program.parseAsync(["search", "meetings", "budget", "--since-time", "2026-09-12T08:00:00+02:00"], {
    from: "user",
  })
  expect(output.mock.calls[0]?.[0].meta).toEqual({ window: { since: "2026-09-12T06:00:00.000Z" } })
})
it("rejects impossible dates and invalid selectors before opening a store", async () => {
  const cases = [
    ["--since-time", "2026-02-30"],
    ["--since-time", "2026-03-29T02:30"],
    ["--identity-id", "0"],
    ["--person-id", "1.5"],
    ["--event-id", "0"],
    ["--series-id", "x"],
    ["--tag", "plan", "--topic-name", "plan"],
    ["--since-time", "2026-10-12", "--until-time", "2026-09-12"],
    ["--limit", "1001"],
    ["--cursor", "!"],
    ["--project", " "],
  ]
  for (const flags of cases) {
    const program = new Command("example").exitOverride()
    const connect = vi.fn()
    addMeetingSearchCommand(program, { search: connect, signal: () => undefined, output: () => {} })
    await expect(program.parseAsync(["search", "meetings", "budget", ...flags], { from: "user" })).rejects.toThrow()
    expect(connect).not.toHaveBeenCalled()
  }
  expect(() => validateMeetingHitSearch(" ")).toThrow()
  expect(() => validateMeetingHitSearch("budget", { project: "RES", projectId: 1 })).toThrow()
})
it("joins a search group the host already has", () => {
  const program = new Command("example")
  program.command("search").command("all")
  addMeetingSearchCommand(program, { search: vi.fn(), signal: () => undefined, output: () => {} })
  expect(program.commands.filter((command) => command.name() === "search")).toHaveLength(1)
  expect(program.commands.find((command) => command.name() === "search")?.commands.map((c) => c.name())).toEqual([
    "all",
    "meetings",
  ])
})

it("shares grammar and validation without interpreting a host's alternate source report as word hits", async () => {
  const program = new Command("example")
  const output = vi.fn()
  overrideSharedContract(
    createMeetingSearchCommand(program),
    "The synthetic host reads its own local archive directory.",
    (command) => {
      command.option("--archive <directory>")
    },
  ).action((query, flags) => {
    const request = meetingHitSearchRequest(query, flags)
    output({ folder: flags.archive, requested: request.limit, matches: [] })
  })
  await program.parseAsync(["search", "meetings", "plan", "--archive", "./invented", "--limit", "2"], { from: "user" })
  expect(output).toHaveBeenCalledWith({ folder: "./invented", requested: 2, matches: [] })
  const aborted = new AbortController()
  aborted.abort()
  const search = vi.fn()
  const cancelled = new Command("example")
  addMeetingSearchCommand(cancelled, { search, output, signal: () => aborted.signal })
  await expect(cancelled.parseAsync(["search", "meetings", "plan"], { from: "user" })).rejects.toThrow()
  expect(search).not.toHaveBeenCalled()
})
