import { CliError } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import { itemEnvelopeSchema } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ENTITIES } from "../entities/index.js"
import { callMeetingPreparationTool, meetingPreparationTool } from "../mcp/meeting-preparation.js"
import { createMeetingPreparationService } from "../services/index.js"
import { preparationFixture } from "../testing/meeting-preparation.js"
import { meetingPreparationAnswer } from "./meeting-preparation-answer.js"
import { addMeetingPreparationCommand } from "./meeting-preparation-command.js"
import { type MeetingPreparationReader, readMeetingPreparation } from "./meeting-preparation-read.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})
const now = 10000
const fixture = async () => {
  const f = await preparationFixture()
  handles.push(f)
  const service = createMeetingPreparationService(f.key, f.accountId, {
    meetings: f.store.meetings,
    upcoming: f.upcoming,
  })
  const read = vi.fn<MeetingPreparationReader>(service.prepare.bind(service))
  return { ...f, read }
}
const cli = (read: MeetingPreparationReader) => {
  const program = new Command("example").exitOverride().configureOutput({ writeErr: () => {} })
  program.command("meetings")
  const output = vi.fn()
  addMeetingPreparationCommand(program, { read, output, signal: () => undefined, now: () => now })
  return { program, output }
}
const args = { series_id: "example-series" }

describe("meeting preparation adapters", () => {
  it("returns owner notes in the same strict CLI and MCP envelope", async () => {
    const f = await fixture()
    const note = await f.store.notes.addNote({ text: "Bring the project checklist", about: [f.project.ref] })
    const { program, output } = cli(f.read)
    await program.parseAsync(["meetings", "prepare", "example-series"], { from: "user" })
    const mcp = await callMeetingPreparationTool(f.read, args, undefined, {}, now)
    expect(mcp.structuredContent).toMatchObject({ item: output.mock.calls[0]?.[0].item })
    expect(mcp.structuredContent).toMatchObject({
      item: {
        notes: {
          items: [{ ref: note.ref, revision: 1, text: note.text }],
          coverage: { source_evidence: "not-revalidated", other_sources: "not-queried" },
        },
      },
    })
  })
  it("uses canonical inclusive-start and exclusive-end time flags with the same MCP windows", async () => {
    const f = await fixture()
    const { program, output } = cli(f.read)
    await program.parseAsync(
      [
        "meetings",
        "prepare",
        "example-series",
        "--since-time",
        "1970-01-01T00:00:10Z",
        "--before-time",
        "1970-01-01T00:00:20Z",
        "--history-since-time",
        "1970-01-01T00:00:00Z",
      ],
      { from: "user" },
    )
    expect(f.read.mock.calls[0]?.[1]).toMatchObject({ after: 10000, until: 20000, historyAfter: 0 })
    const mcp = await callMeetingPreparationTool(
      f.read,
      { ...args, after: "1970-01-01T00:00:10Z", until: "1970-01-01T00:00:20Z", history_after: "1970-01-01T00:00:00Z" },
      undefined,
      {},
      now,
    )
    expect(mcp.structuredContent).toMatchObject({ item: output.mock.calls[0]?.[0].item })
    expect(JSON.stringify(describeProgram(program))).toContain("example meetings prepare 123 --json")
  })
  it("reports skipped sources through common metadata and rejects a changed reader selection", async () => {
    const f = await fixture()
    const read: MeetingPreparationReader = async (...params) => {
      const packet = await f.read(...params)
      packet.coverage.skippedUnavailable = [f.reference]
      return packet
    }
    const result = await readMeetingPreparation(read, args, undefined, now)
    expect(result.meta).toMatchObject({ complete: false, issues: [{ code: "not_found", source: f.reference }] })
    const wrong: MeetingPreparationReader = async (...params) => {
      const packet = await f.read(...params)
      packet.upcoming.meetingId = "other-series"
      return packet
    }
    await expect(readMeetingPreparation(wrong, args, undefined, now)).rejects.toMatchObject({
      code: "invalid_response",
    })
  })

  it("refuses non-object and non-plain arguments before reads", async () => {
    const read = vi.fn<MeetingPreparationReader>()
    for (const input of [null, [], "x", Object.create(args)]) {
      expect(await callMeetingPreparationTool(read, input, undefined, {}, now)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "validation_error" } },
      })
    }
    expect(read).not.toHaveBeenCalled()
  })
  it("CLI and MCP share normalized windows, the registered entity and complete envelopes", async () => {
    const f = await fixture()
    const { program, output } = cli(f.read)
    await program.parseAsync(["meetings", "prepare", "example-series", "--meetings", "2", "--cues", "1"], {
      from: "user",
    })
    const answer = output.mock.calls[0]?.[0]
    const mcp = await callMeetingPreparationTool(f.read, { ...args, meetings: 2, cues: 1 }, undefined, {}, now)
    expect(mcp).not.toHaveProperty("isError")
    expect(mcp.structuredContent).toMatchObject({ item: answer.item, meta: { complete: true } })
    expect(v.safeParse(itemEnvelopeSchema(ENTITIES.meeting_preparation), answer).success).toBe(true)
    expect(JSON.parse(mcp.content[0]?.text ?? "null")).toEqual(mcp.structuredContent)
    expect(f.read.mock.calls[0]?.[1]).toMatchObject({
      after: now,
      until: now + 7 * 86400000,
      historyAfter: now - 30 * 86400000,
      meetings: 2,
      cues: 1,
    })
    expect(answer.item.meetings[0]).toMatchObject({
      ref: f.reference,
      meeting: { id: String(f.context.meetingId), started_at: "1970-01-01T00:00:01.000Z" },
      evidence: { items: [{ ref: expect.any(String), transcript_id: expect.any(String), offset_ms: 0, position: 0 }] },
      context: {
        participants: { items: [{ id: expect.any(String), identity_id: expect.any(String) }] },
        facts: { items: [{ updated_at: expect.any(String) }] },
      },
    })
    expect(JSON.stringify(describeProgram(program))).toContain('"entity":"meeting_preparation"')
    expect(meetingPreparationTool.inputSchema).toMatchObject({ additionalProperties: false })
    expect(JSON.stringify(meetingPreparationTool.inputSchema)).not.toContain("account_id")
  })

  it("normalizes explicit offset windows and preserves limits and unknown coverage", async () => {
    const f = await fixture()
    const answer = await readMeetingPreparation(
      f.read,
      {
        ...args,
        after: "1970-01-01T01:00:10+01:00",
        until: "1970-01-01T01:00:20+01:00",
        history_after: "1970-01-01T00:00:00Z",
        context_limit: 1,
        max_read_bytes: 4096,
        bytes: 8192,
      },
      undefined,
      now,
    )
    expect(answer.item.upcoming).toMatchObject({ after: "1970-01-01T00:00:10.000Z", until: "1970-01-01T00:00:20.000Z" })
    expect(answer.item.limits).toMatchObject({ context_limit: 1, max_read_bytes: 4096, bytes: 8192 })
    expect(answer.item.coverage).toMatchObject({
      archive_completeness: "unknown",
      fact_evidence: "not-revalidated",
      unqueried: ["person-nonmeeting-context", "project-nonmeeting-context", "project-alias-candidates"],
    })
    const evidence = answer.item.meetings[0]?.evidence
    expect(evidence?.content_bytes).toBe(Buffer.byteLength(JSON.stringify(evidence?.items)))
  })

  it.each([
    { account_id: 2 },
    { unexpected: "x" },
    { after: "2026-02-30T10:00:00Z" },
    { after: "2026-10-14" },
    { after: "2026-10-14T10:00:00" },
    { until: "1970-01-01T00:00:01Z" },
    { history_after: "1970-01-02T00:00:00Z" },
    { meetings: 21 },
    { context_limit: 0 },
    { cues: 1.5 },
    { max_read_bytes: 4194305 },
    { bytes: 1 },
    { series_id: "\n" },
  ])("rejects bad arguments before the bound reader: %j", async (patch) => {
    const read = vi.fn<MeetingPreparationReader>()
    const result = await callMeetingPreparationTool(read, { ...args, ...patch }, undefined, {}, now)
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "validation_error" } } })
    if ("account_id" in patch) expect(JSON.stringify(result)).toContain("account_id")
    if ("unexpected" in patch) expect(JSON.stringify(result)).toContain("unexpected")
    if ("context_limit" in patch) expect(JSON.stringify(result)).toContain("context_limit")
    expect(read).not.toHaveBeenCalled()
  })

  it("rejects CLI unknown options, malformed integers and missing groups without opening resources", async () => {
    const read = vi.fn<MeetingPreparationReader>()
    for (const extra of [
      ["--unknown", "x"],
      ["--cues", "1.5"],
      ["--meetings", "21"],
    ]) {
      await expect(
        cli(read).program.parseAsync(["meetings", "prepare", "example-series", ...extra], { from: "user" }),
      ).rejects.toBeDefined()
    }
    expect(read).not.toHaveBeenCalled()
    expect(() =>
      addMeetingPreparationCommand(new Command(), { read, output: () => {}, signal: () => undefined }),
    ).toThrow("group is unavailable")
  })

  it("emits structured provider and internal errors, and refuses late cancellation", async () => {
    const failure = new CliError("not_found", "Invented schedule unavailable")
    const read = vi.fn<MeetingPreparationReader>(async () => {
      throw failure
    })
    expect(await callMeetingPreparationTool(read, args, undefined, {}, now)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "not_found" } },
    })
    read.mockRejectedValueOnce(new Error("Invented confidential exception text"))
    const internal = await callMeetingPreparationTool(read, args, undefined, {}, now)
    expect(internal).toMatchObject({ isError: true })
    expect(JSON.stringify(internal)).not.toContain("confidential")
    const f = await fixture()
    const controller = new AbortController()
    const cancelled: MeetingPreparationReader = async (...params) => {
      const packet = await f.read(...params)
      controller.abort(new CliError("timeout", "Invented deadline"))
      return packet
    }
    expect(await callMeetingPreparationTool(cancelled, args, controller.signal, {}, now)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "timeout" } },
    })
  })

  it("keeps the normalized public item within its own byte bound", async () => {
    const f = await fixture()
    const packet = await f.read(args.series_id, { ...f.request, bytes: 65536 })
    delete packet.notes
    const full = meetingPreparationAnswer(packet)
    packet.limits.bytes = Buffer.byteLength(JSON.stringify(full.item)) - 100
    const answer = meetingPreparationAnswer(packet)
    expect(answer.item.meetings).toHaveLength(1)
    expect(answer.item.knowledge).toBeUndefined()
    expect(answer.item.coverage.output_limited).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(answer.item))).toBeLessThanOrEqual(packet.limits.bytes)
    delete packet.knowledge
    const withoutKnowledge = meetingPreparationAnswer({ ...packet, limits: { ...packet.limits, bytes: 65536 } })
    packet.limits.bytes = Buffer.byteLength(JSON.stringify(withoutKnowledge.item)) - 100
    expect(meetingPreparationAnswer(packet).item.meetings).toEqual([])
    packet.limits.bytes = 1
    expect(() => meetingPreparationAnswer(packet)).toThrow("increase the output budget")
    packet.upcoming.meetingId = ""
    expect(() => meetingPreparationAnswer(packet)).toThrow("answer contract")
  })
})
