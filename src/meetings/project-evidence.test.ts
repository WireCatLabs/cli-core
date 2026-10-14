import { CliError } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import * as v from "valibot"
import { expect, it, vi } from "vitest"
import { addMeetingProjectEvidenceCommand } from "./cli/project-evidence.js"
import { callMeetingProjectEvidenceTool, meetingProjectEvidenceTool } from "./mcp/project-evidence.js"
import type { MeetingProjectDiscoveryPage, MeetingProjectDiscoveryReader } from "./project-discovery.js"
import { readMeetingProjectEvidence } from "./project-evidence.js"
import { meetingProjectEvidence } from "./project-evidence-answer.js"
import { prepareMeetingProjectEvidence } from "./project-evidence-query.js"

const now = Date.parse("2026-10-14T12:00:00Z")
const page = (): MeetingProjectDiscoveryPage => ({
  schemaVersion: 1,
  kind: "meeting_project_discovery",
  accountId: 1,
  query: "RES",
  limits: { limit: 2, maxReadBytes: 1024, maxVocabularyReadBytes: 1048576, maxTerms: 32 },
  project: { id: "7", name: "Research Example", key: "RES" },
  term: { name: "исследование", kind: "alias", aliasId: "9" },
  hits: [{ ref: "meeting:1/2/3/0", meetingId: 2, scope: "transcript", id: 5, text: "launch", startMs: 1000 }],
  association: "unconfirmed-word-evidence",
  vocabularyFingerprint: "sample-fingerprint",
  hasMore: true,
  nextCursor: "next-name",
  coverage: {
    archiveCompleteness: "unknown",
    currentRevisions: true,
    indexing: "pending",
    indexCompleteness: "unknown",
    termIndex: 2,
    termsTotal: 4,
    remainingTerms: 1,
    duplicates: "may-repeat-between-terms",
  },
})

const cli = (read: MeetingProjectDiscoveryReader) => {
  const program = new Command("example").exitOverride()
  program.command("meetings").command("evidence").argument("<reference>")
  const output = vi.fn()
  addMeetingProjectEvidenceCommand(program, { read, output, signal: () => undefined, now: () => now })
  return { program, output }
}

it("CLI and MCP retain the complete registered evidence entity and replay every selection", async () => {
  const read = vi.fn<MeetingProjectDiscoveryReader>(async () => page())
  const { program, output } = cli(read)
  const query = "identity_id:12 person_id:34 meeting_id:2 tag_id:8 event_id:56 series_id:78 started_at:[7d TO today]"
  await program.parseAsync(
    ["meetings", "projects", "evidence", "RES", query, "--limit", "2", "--max-read-bytes", "1024"],
    {
      from: "user",
    },
  )
  const response = await callMeetingProjectEvidenceTool(
    read,
    { project: "RES", query, limit: 2, max_read_bytes: 1024 },
    undefined,
    {},
    now,
  )
  expect(response).not.toHaveProperty("isError")
  const answer = output.mock.calls[0]?.[0]
  expect(response.structuredContent).toEqual(answer)
  expect(v.safeParse(meetingProjectEvidence, answer.item).success).toBe(true)
  expect(answer.item).toMatchObject({
    account_id: "1",
    project: { id: "7" },
    term: { kind: "alias", alias_id: "9" },
    selection: {
      identity_id: "12",
      person_id: "34",
      meeting_id: "2",
      tag_id: "8",
      event_id: "56",
      series_id: "78",
      since: "2026-10-07T12:00:00.000Z",
      until: "2026-10-14T23:59:59.999Z",
    },
    association: "unconfirmed-word-evidence",
    coverage: { indexing: "pending", archive_completeness: "unknown" },
    hits: [{ ref: "meeting:1/2/3/0", meeting: "meeting:1/2", excerpt: "launch" }],
    page: { has_more: true, cursor: "next-name" },
  })
  const next = answer.next[0]
  expect(next).toMatchObject({
    step: "page.next",
    command: "meetings projects evidence",
    args: { project: "RES", limit: 2, cursor: "next-name", max_read_bytes: 1024 },
  })
  expect(next.args.query).not.toContain("7d")
  expect(prepareMeetingProjectEvidence("RES", { query: next.args.query }, now + 86400000).options).toMatchObject({
    participantIdentityId: 12,
    personId: 34,
    meetingId: 2,
    tagId: 8,
    eventId: 56,
    meetingSeriesId: 78,
    since: Date.parse("2026-10-07T12:00:00Z"),
    until: Date.parse("2026-10-14T23:59:59.999Z"),
  })
  expect(read.mock.calls[0]?.[1]).not.toHaveProperty("accountId")
  expect(JSON.stringify(describeProgram(program))).toContain("meeting_project_evidence")
  expect(program.commands[0]?.commands.map((command) => command.name())).toEqual(["evidence", "projects"])
  expect(meetingProjectEvidenceTool.inputSchema.properties).not.toHaveProperty("account_id")
  expect(meetingProjectEvidenceTool.outputSchema).toMatchObject({
    type: "object",
    anyOf: expect.arrayContaining([
      expect.objectContaining({ required: ["item", "meta"] }),
      expect.objectContaining({ required: ["error"] }),
    ]),
  })
})

it("empty name pages keep continuation and exhausted pages omit it", async () => {
  const empty = { ...page(), hits: [] }
  const read = vi.fn(async () => empty)
  const found = await readMeetingProjectEvidence(read, "RES")
  expect(found.item.hits).toEqual([])
  expect(found.next?.[0]).toMatchObject({ args: { project: "RES", cursor: "next-name" } })
  empty.hasMore = false
  empty.nextCursor = null
  expect(await readMeetingProjectEvidence(read, "RES")).not.toHaveProperty("next")
})

it("rejects malformed inputs and unsupported query semantics before any port read", async () => {
  const read = vi.fn(async () => page())
  for (const input of [
    null,
    [],
    {},
    { project: null },
    { project: "" },
    { project: "RES", account_id: 9 },
    { project: "RES", limit: null },
    { project: "RES", max_read_bytes: null },
    { project: "RES", cursor: 3 },
    { project: "RES", limit: 1001 },
    { project: "RES", max_read_bytes: 0 },
    { project: "RES", query: " ".repeat(8193) },
    ...[
      "identity_id:0",
      "person_id:9007199254740992",
      "identity_id:1 OR person_id:2",
      "-identity_id:1",
      "identity_id:1 identity_id:2",
      "meeting_id:[1 TO 3]",
      "project_id:7",
      "title:launch",
      "launch",
      "started_at:[2026-10-15 TO 2026-10-01]",
      "started_at:2026-02-30",
    ].map((query) => ({ project: "RES", query })),
  ]) {
    expect(await callMeetingProjectEvidenceTool(read, input)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "validation_error" } },
    })
  }
  const { program, output } = cli(read)
  await expect(
    program.parseAsync(["meetings", "projects", "evidence", "RES", "identity_id:0"], { from: "user" }),
  ).rejects.toMatchObject({ code: "validation_error" })
  expect(output).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

it("converts date exclusivity and calendar boundaries into repeatable inclusive millisecond bounds", () => {
  for (const query of [
    "started_at:2026-10-01",
    "started_at:[2026-10-01 TO 2026-10-02]",
    "started_at:{2026-10-01 TO 2026-10-04}",
    'started_at>"2026-10-01T12:00:00Z"',
    "started_at:7d",
  ]) {
    const first = prepareMeetingProjectEvidence("RES", { query }, now)
    expect(prepareMeetingProjectEvidence("RES", { query: first.query }, now + 86400000).options).toEqual(first.options)
  }
  expect(prepareMeetingProjectEvidence("RES", { query: 'started_at>"2026-10-01T12:00:00Z"' }, now).options.since).toBe(
    Date.parse("2026-10-01T12:00:00Z") + 1,
  )
})

it("preserves service failures and prevents output after cancellation or invalid continuation", async () => {
  const controller = new AbortController()
  const read = vi.fn(async () => {
    controller.abort()
    return page()
  })
  expect(await callMeetingProjectEvidenceTool(read, { project: "RES" }, controller.signal)).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "cancelled" } },
  })
  read.mockClear()
  expect(await callMeetingProjectEvidenceTool(read, { project: "RES" }, controller.signal)).toHaveProperty(
    "isError",
    true,
  )
  expect(read).not.toHaveBeenCalled()
  const failing = async () => {
    throw new CliError("not_found", "no such invented project")
  }
  expect(await callMeetingProjectEvidenceTool(failing, { project: "RES" })).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "not_found" } },
  })
  const invalid = { ...page(), nextCursor: null }
  await expect(readMeetingProjectEvidence(async () => invalid, "RES")).rejects.toMatchObject({
    code: "invalid_response",
  })
  await expect(
    readMeetingProjectEvidence(async () => ({ ...page(), limits: { ...page().limits, limit: -1 } }), "RES"),
  ).rejects.toMatchObject({ code: "invalid_response" })
  expect(() =>
    addMeetingProjectEvidenceCommand(new Command("empty"), { read: failing, signal: () => undefined, output: vi.fn() }),
  ).toThrow("meeting command group is unavailable")
})
