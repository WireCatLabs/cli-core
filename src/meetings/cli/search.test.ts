import { Command } from "commander"
import { expect, it, vi } from "vitest"
import { addMeetingSearchCommand, validateMeetingHitSearch } from "./search.js"

it("forwards combined context, dates and continuation to an injected provider-neutral search", async () => {
  const program = new Command("example")
  const controller = new AbortController()
  const result = {
    items: [
      { ref: "meeting:1/2/3/0", meetingId: 2, scope: "transcript" as const, id: 9, text: "the budget", startMs: 1500 },
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
      "--topic",
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
      since: Date.parse("2026-09-12"),
      until: Date.parse("2026-10-12"),
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
      },
    ],
    page: { limit: 10, has_more: true, cursor: "next-page" },
    next: [
      expect.objectContaining({
        step: "page.next",
        command: "search meetings",
        args: { cursor: "next-page", limit: 10 },
      }),
    ],
  })
})
it("rejects impossible dates and invalid selectors before opening a store", async () => {
  const cases = [
    ["--since-time", "2026-02-30"],
    ["--since-time", "2026-10-12T10:00:00"],
    ["--identity-id", "0"],
    ["--person-id", "1.5"],
    ["--event-id", "0"],
    ["--series-id", "x"],
    ["--tag", "plan", "--topic", "plan"],
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
