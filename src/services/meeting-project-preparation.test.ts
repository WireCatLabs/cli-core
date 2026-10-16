import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import { afterEach, expect, it, vi } from "vitest"
import { meetingPreparationAnswer } from "../cli/meeting-preparation-answer.js"
import { addMeetingPreparationCommand } from "../cli/meeting-preparation-command.js"
import { callMeetingPreparationTool } from "../mcp/meeting-preparation.js"
import { preparationFixture } from "../testing/meeting-preparation.js"
import { createMeetingPreparationService } from "./meeting-preparation.js"
import { readMeetingProjectDiscovery } from "./meeting-project-discovery.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})
const fixture = async (provider = "example-calendar") => {
  const f = await preparationFixture(provider)
  handles.push(f)
  await f.store.knowledge.addVocabularyAlias({ kind: "project", id: f.project.id }, "Bureau Example")
  await f.store.knowledge.addVocabularyAlias({ kind: "project", id: f.project.id }, "НББ")
  await f.store.knowledge.addVocabularyAlias({ kind: "project", id: f.project.id }, "Национальное бюро")
  if (!f.input.meeting.series) throw Error("missing invented series")
  const input = {
    ...f.input,
    meeting: {
      ...f.input.meeting,
      externalId: "unlinked-call",
      title: "НББ",
      startedAt: 9000,
      series: { ...f.input.meeting.series, externalId: "unlinked-series" },
    },
    transcripts: f.input.transcripts.map((t) => ({
      ...t,
      rows: t.rows.map((row) => ({ ...row, text: "HAR Bureau Example НББ" })),
    })),
  }
  const candidate = await f.store.meetings.saveMeeting(input)
  await f.store.meetings.saveMeeting({ ...input, meeting: { ...input.meeting, accountId: f.otherId } })
  await f.store.meetings.saveMeeting({
    ...input,
    meeting: { ...input.meeting, externalId: "future-call", startedAt: 10000 },
  })
  await f.store.meetings.indexSearch({ accountId: f.accountId })
  await f.store.meetings.indexSearch({ accountId: f.otherId })
  const projectDiscovery = { vocabulary: f.store.knowledge, search: f.store.meetings }
  const ports = { meetings: f.store.meetings, upcoming: f.upcoming, projectDiscovery }
  const service = createMeetingPreparationService(f.key, f.accountId, ports)
  return { ...f, ports, service, candidate }
}

it.each(["example-calendar", "another-calendar"])(
  "prepares cited unconfirmed aliases for %s without writes or cross-account/future hits",
  async (provider) => {
    const f = await fixture(provider)
    const vocabulary = await f.store.knowledge.vocabulary({ kind: "project" })
    const search = vi.spyOn(f.store.meetings, "searchHits")
    const result = await f.service.prepare("example-series", { ...f.request, project: "HAR" })
    const section = result.projectEvidence
    expect(section?.pages.map((page) => page.term.name)).toEqual([
      "Harbour Example",
      "HAR",
      "Bureau Example",
      "Национальное бюро",
    ])
    expect(section?.pages[0]?.hits).toEqual([])
    expect(section?.pages[1]?.hits[0]?.ref).toBe(section?.pages[2]?.hits[0]?.ref)
    expect(section?.coverage).toEqual({ pageLimit: 4, hasMore: true, outputLimited: false })
    for (const page of section?.pages ?? []) {
      expect(page.association).toBe("unconfirmed-word-evidence")
      expect(
        page.hits.every(
          (hit) => hit.meetingId === f.candidate.meeting.id && hit.ref.startsWith(`meeting:${f.accountId}/`),
        ),
      ).toBe(true)
    }
    expect(search).toHaveBeenCalledTimes(4)
    for (const [, args] of search.mock.calls)
      expect(args).toMatchObject({ accountId: f.accountId, since: 0, until: 9999, limit: 20, maxReadBytes: 262144 })
    const answer = meetingPreparationAnswer(result).item.project_evidence
    expect(answer?.continuation).toMatchObject({
      command: "meetings projects evidence",
      project: "HAR",
      query: section?.query,
    })
    const continuation = answer?.continuation
    if (!continuation?.cursor) throw Error("missing continuation")
    const page = await readMeetingProjectDiscovery(f.ports.projectDiscovery, continuation.project, {
      accountId: f.accountId,
      since: 0,
      until: 9999,
      cursor: continuation.cursor,
    })
    expect(page.term).toMatchObject({ name: "НББ", kind: "alias" })
    expect(page.hits.some((hit) => hit.source?.title === "НББ" && hit.scope === "transcript")).toBe(true)
    expect(await f.store.knowledge.vocabulary({ kind: "project" })).toEqual(vocabulary)
    expect(
      (await f.store.knowledge.meetingProjects(f.key, { meetingId: String(f.candidate.meeting.id) })).items,
    ).toEqual([])
  },
)

it("keeps old preparation unchanged, supports an unstored series, and refuses unsupported project requests before the provider read", async () => {
  const f = await fixture()
  const search = vi.spyOn(f.store.meetings, "searchHits")
  expect(await f.service.prepare("example-series", f.request)).not.toHaveProperty("projectEvidence")
  expect(search).not.toHaveBeenCalled()
  const legacy = createMeetingPreparationService(f.key, f.accountId, {
    meetings: f.store.meetings,
    upcoming: f.upcoming,
  })
  expect(() =>
    createMeetingPreparationService(f.key, f.accountId, { ...f.ports, projectDiscovery: {} as never }),
  ).toThrow("Meeting preparation requires bounded meeting reads")
  const reads = f.reads()
  await expect(legacy.prepare("example-series", { ...f.request, project: "HAR" })).rejects.toMatchObject({
    code: "configuration_error",
  })
  expect(f.reads()).toBe(reads)
  const result = await f.service.prepare("unstored-series", { ...f.request, project: "HAR" })
  expect(result.series).toBeNull()
  expect(result.projectEvidence?.pages).toHaveLength(4)
})

it("uses the same strict CLI/MCP request and mapping", async () => {
  const f = await fixture()
  const program = new Command("example")
  program.command("meetings")
  const output = vi.fn()
  addMeetingPreparationCommand(program, { read: f.service.prepare, output, signal: () => undefined, now: () => 10000 })
  await program.parseAsync(["meetings", "prepare", "example-series", "--project", "HAR"], { from: "user" })
  const mcp = await callMeetingPreparationTool(
    f.service.prepare,
    { series_id: "example-series", project: "HAR" },
    undefined,
    {},
    10000,
  )
  expect(mcp.structuredContent).toMatchObject({ item: output.mock.calls[0]?.[0].item })
  expect(mcp).not.toHaveProperty("isError")
  const read = vi.fn()
  for (const project of ["", " ", "HAR\n", 3]) {
    const bad = await callMeetingPreparationTool(read, { series_id: "example-series", project }, undefined, {}, 10000)
    expect(bad).toMatchObject({ isError: true, structuredContent: { error: { code: "validation_error" } } })
  }
  expect(read).not.toHaveBeenCalled()
})

it("reports pending indexes without refreshing them and refuses vocabulary changes mid-read", async () => {
  const f = await fixture()
  const index = vi.spyOn(f.store.meetings, "indexSearch")
  f.db
    .prepare(
      "UPDATE meeting_transcript_rows SET text=text || ? WHERE meeting_transcript_id IN (SELECT id FROM meeting_transcripts WHERE meeting_id=?)",
    )
    .run(" revised", f.candidate.meeting.id)
  const result = await f.service.prepare("example-series", { ...f.request, project: "HAR" })
  expect(result.projectEvidence?.pages.every((page) => page.coverage.indexing === "pending")).toBe(true)
  expect(index).not.toHaveBeenCalled()
  const original = f.store.meetings.searchHits.bind(f.store.meetings)
  vi.spyOn(f.store.meetings, "searchHits").mockImplementationOnce(async (...args) => {
    const page = await original(...args)
    await f.store.knowledge.addVocabularyAlias({ kind: "project", id: f.project.id }, "New Alias")
    return page
  })
  await expect(f.service.prepare("example-series", { ...f.request, project: "HAR" })).rejects.toMatchObject({
    code: "validation_error",
  })
})

it("preserves established context when SDK/public/escaped output trims candidates, with restart-safe continuation", async () => {
  const f = await fixture()
  const full = await f.service.prepare("example-series", { ...f.request, project: "HAR" })
  const normal = meetingPreparationAnswer(full)
  full.limits.bytes = Buffer.byteLength(JSON.stringify(normal.item)) - 100
  const answer = meetingPreparationAnswer(full)
  expect(answer.item.project_evidence?.pages.length).toBeLessThan(4)
  expect(answer.item.meetings).toEqual(normal.item.meetings)
  expect(answer.item.coverage.output_limited).toBe(true)
  const section = answer.item.project_evidence
  const last = section?.pages.at(-1)?.page
  expect(section?.continuation?.cursor).toBe(last?.mode === "cursor" ? (last.next_cursor ?? null) : null)
  expect(Buffer.byteLength(JSON.stringify(answer.item))).toBeLessThanOrEqual(full.limits.bytes)
  const legacy = await f.service.prepare("example-series", f.request)
  const small = await f.service.prepare("example-series", {
    ...f.request,
    project: "HAR",
    bytes: Buffer.byteLength(JSON.stringify(legacy)) + 100,
  })
  expect(small.items.map((item) => ({ ref: item.reference, cues: item.evidence.items }))).toEqual(
    legacy.items.map((item) => ({ ref: item.reference, cues: item.evidence.items })),
  )
  expect(small.coverage.outputLimited).toBe(true)
})

it("propagates vocabulary/read failures and late cancellation", async () => {
  const f = await fixture()
  await expect(f.service.prepare("example-series", { ...f.request, project: "Missing" })).rejects.toMatchObject({
    code: "not_found",
  })
  const controller = new AbortController()
  const original = f.store.meetings.searchHits.bind(f.store.meetings)
  vi.spyOn(f.store.meetings, "searchHits").mockImplementation(async (...args) => {
    const page = await original(...args)
    controller.abort(new CliError("timeout", "Invented deadline"))
    return page
  })
  await expect(
    f.service.prepare("example-series", { ...f.request, project: "HAR", signal: controller.signal }),
  ).rejects.toMatchObject({ code: "timeout" })
})

it("finishes a one-name vocabulary and exposes byte failures without converting them to empty matches", async () => {
  const f = await fixture()
  await f.store.knowledge.addProject({ name: "ONE", key: "ONE" })
  const result = await f.service.prepare("example-series", { ...f.request, project: "ONE" })
  expect(result.projectEvidence).toMatchObject({ pages: [{ hits: [], hasMore: false }], coverage: { hasMore: false } })
  expect(meetingPreparationAnswer(result).item.project_evidence?.continuation).toBeNull()
  const read = vi
    .spyOn(f.store.knowledge, "resolveVocabulary")
    .mockRejectedValueOnce(new CliError("validation_error", "Invented vocabulary byte overflow"))
  await expect(f.service.prepare("example-series", { ...f.request, project: "HAR" })).rejects.toThrow(
    "Invented vocabulary byte overflow",
  )
  expect(read).toHaveBeenCalledWith("HAR", expect.objectContaining({ maxReadBytes: 262144, signal: undefined }))
})

it("bounds the escaped MCP item and rewinds continuation to the last retained page", async () => {
  const f = await fixture()
  const packet = await f.service.prepare("example-series", { ...f.request, project: "HAR" })
  const hit = packet.projectEvidence?.pages[1]?.hits[0]
  if (!hit) throw Error("missing invented hit")
  hit.text = "\u200e".repeat(1000)
  const normal = meetingPreparationAnswer(packet)
  packet.limits.bytes = Buffer.byteLength(JSON.stringify(normal.item)) + 10
  const result = await callMeetingPreparationTool(async () => packet, {
    series_id: "example-series",
    project: "HAR",
    after: "1970-01-01T00:00:10Z",
    until: "1970-01-01T00:00:20Z",
    history_after: "1970-01-01T00:00:00Z",
    bytes: packet.limits.bytes,
  })
  expect(result).not.toHaveProperty("isError")
  const answer = result.structuredContent as typeof normal
  expect(answer.item.project_evidence?.pages.length).toBeLessThan(4)
  expect(answer.item.meetings).toEqual(normal.item.meetings)
  const section = answer.item.project_evidence
  const last = section?.pages.at(-1)?.page
  expect(section?.continuation?.cursor).toBe(last?.mode === "cursor" ? (last.next_cursor ?? null) : null)
  expect(answer.meta?.truncated).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(answer.item))).toBeLessThanOrEqual(packet.limits.bytes)
})

it("normalizes cancellation raised while resolving project names", async () => {
  const f = await fixture()
  const controller = new AbortController()
  vi.spyOn(f.store.knowledge, "resolveVocabulary").mockImplementation(async () => {
    controller.abort(new Error("Invented interruption"))
    throw controller.signal.reason
  })
  await expect(
    f.service.prepare("example-series", { ...f.request, project: "HAR", signal: controller.signal }),
  ).rejects.toMatchObject({ code: "cancelled" })
})
