import { Command } from "commander"
import { expect, it, vi } from "vitest"
import { addMeetingHitSearchCommand, validateMeetingHitSearch } from "./search.js"

it("forwards combined context, dates and continuation to an injected provider-neutral search", async () => {
  const program = new Command("example")
  program.command("meetings")
  const controller = new AbortController()
  const result = {
    items: [],
    hasMore: false,
    nextCursor: null,
    coverage: {
      archiveCompleteness: "unknown" as const,
      currentRevisions: true as const,
      indexing: "ready" as const,
      indexCompleteness: "unknown" as const,
    },
  }
  const search = vi.fn(async () => result)
  const output = vi.fn()
  addMeetingHitSearchCommand(program, { search: async () => search, signal: () => controller.signal, output })
  await program.parseAsync(
    [
      "meetings",
      "search-page",
      "budget",
      "--identity-id",
      "12",
      "--person-id",
      "34",
      "--project",
      "RES",
      "--topic",
      "costs",
      "--since",
      "2026-09-12",
      "--until",
      "2026-10-12",
      "--after",
      "abc",
      "--limit",
      "10",
    ],
    { from: "user" },
  )
  expect(search).toHaveBeenCalledWith("budget", {
    participantIdentityId: 12,
    personId: 34,
    project: "RES",
    topic: "costs",
    since: Date.parse("2026-09-12"),
    until: Date.parse("2026-10-12"),
    after: "abc",
    limit: 10,
    signal: controller.signal,
  })
  expect(output).toHaveBeenCalledWith(result)
})
it("rejects impossible dates and invalid selectors before opening a store", async () => {
  const cases = [
    ["--since", "2026-02-30"],
    ["--since", "2026-10-12T10:00:00"],
    ["--identity-id", "0"],
    ["--person-id", "1.5"],
    ["--tag", "plan", "--topic", "plan"],
    ["--since", "2026-10-12", "--until", "2026-09-12"],
    ["--limit", "1001"],
    ["--after", "!"],
    ["--project", " "],
  ]
  for (const flags of cases) {
    const program = new Command("example").exitOverride()
    program.command("meetings")
    const connect = vi.fn()
    addMeetingHitSearchCommand(program, { search: connect, signal: () => undefined, output: () => {} })
    await expect(
      program.parseAsync(["meetings", "search-page", "budget", ...flags], { from: "user" }),
    ).rejects.toThrow()
    expect(connect).not.toHaveBeenCalled()
  }
  expect(() =>
    addMeetingHitSearchCommand(new Command(), { search: vi.fn(), signal: () => undefined, output: () => {} }),
  ).toThrow()
  expect(() => validateMeetingHitSearch(" ")).toThrow()
  expect(() => validateMeetingHitSearch("budget", { project: "RES", projectId: 1 })).toThrow()
})
