import { describeProgram } from "@wirecat/cli-base/commands"
import { itemEnvelopeSchema } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import * as v from "valibot"
import { afterEach, expect, it, vi } from "vitest"
import { meetingPreparation } from "../entities/meeting-preparation.js"
import { callMeetingPreparationTool, meetingPreparationTool } from "../mcp/meeting-preparation.js"
import { createMeetingPreparationService } from "../services/meeting-preparation.js"
import { contextEvidenceFixture } from "../testing/context-evidence.js"
import { addMeetingPreparationCommand } from "./meeting-preparation-command.js"
import { type MeetingPreparationReader, readMeetingPreparation } from "./meeting-preparation-read.js"

const present = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing fixture value")
  return value
}
const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const f of handles.splice(0)) await f.close()
})
const setup = async () => {
  const f = await contextEvidenceFixture()
  handles.push(f)
  const service = createMeetingPreparationService(f.key, f.accountId, {
    meetings: f.store.meetings,
    upcoming: f.upcoming,
    communications: { reader: f.port, selections: [{ id: "project-chat", source: f.sources.message }] },
  })
  const read = vi.fn<MeetingPreparationReader>(service.prepare)
  const program = new Command("example").exitOverride()
  program.command("meetings")
  const output = vi.fn()
  addMeetingPreparationCommand(program, { read, output, signal: () => undefined, now: () => 10000 })
  return { ...f, read, program, output }
}
const input = { series_id: "example-series", communications: { sources: [{ id: "project-chat" }], query: "launch" } }

it("publishes the same strict optional contract through CLI and MCP", async () => {
  const f = await setup()
  await f.program.parseAsync(
    ["meetings", "prepare", "example-series", "--context-source", "project-chat", "--context-query", "launch"],
    { from: "user" },
  )
  const cli = f.output.mock.calls[0]?.[0]
  const mcp = await callMeetingPreparationTool(f.read, input, undefined, {}, 10000)
  expect(mcp.structuredContent).toMatchObject({ item: cli.item })
  expect(v.safeParse(itemEnvelopeSchema(meetingPreparation), mcp.structuredContent).success).toBe(true)
  expect(JSON.stringify(describeProgram(f.program))).toContain("--context-source")
  expect(JSON.stringify(meetingPreparationTool.inputSchema)).toContain("communications")
  expect(cli.item.communications.window).toEqual({
    after: "1970-01-01T00:00:00.000Z",
    before: "1970-01-01T00:00:10.000Z",
  })
})

it("resumes the selected source through CLI syntax with explicit replay windows", async () => {
  const f = await setup()
  const page = await f.port.read({ source: f.sources.message, query: "launch", after: 0, before: 10000, limit: 1 })
  const cursor = Buffer.from(JSON.stringify(page.next)).toString("base64url")
  await f.program.parseAsync(
    [
      "meetings",
      "prepare",
      "example-series",
      "--context-source",
      `project-chat=${cursor}`,
      "--context-query",
      "launch",
      "--context-since-time",
      "1970-01-01T00:00:00Z",
      "--context-before-time",
      "1970-01-01T00:00:10Z",
    ],
    { from: "user" },
  )
  const item = f.output.mock.calls[0]?.[0].item.communications
  expect(item.items.map((i: { ref: string }) => i.ref)).toEqual([
    "msg:example-calendar/AliceExample/planning/2",
    "msg:example-calendar/AliceExample/planning/1",
  ])
})

it("rejects unknown nested fields and malformed selections in the handler before a host read", async () => {
  const f = await setup()
  for (const communications of [
    { ...input.communications, provider: "foreign" },
    { ...input.communications, sources: [{ id: "project-chat", account_id: "2" }] },
    { ...input.communications, sources: [] },
    { ...input.communications, query: "?" },
    { ...input.communications, before: "not-zoned" },
  ]) {
    const result = await callMeetingPreparationTool(f.read, { ...input, communications }, undefined, {}, 10000)
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "validation_error" } } })
  }
  const unknown = await callMeetingPreparationTool(
    f.read,
    { ...input, communications: { ...input.communications, surprise: 1 } },
    undefined,
    {},
    10000,
  )
  expect(JSON.stringify(unknown.structuredContent)).toContain("communications.surprise")
  expect(f.read).not.toHaveBeenCalled()
  expect(f.reads()).toBe(0)
})

it("preserves required coverage and existing evidence when MCP escaping fills the output allowance", async () => {
  const f = await setup()
  f.db.prepare("UPDATE messages SET text=? WHERE account_id=?").run(`Launch ${"\u202e".repeat(220)}`, f.accountId)
  const cli = await readMeetingPreparation(f.read, { ...input, bytes: 4096 }, undefined, 10000)
  const mcp = await callMeetingPreparationTool(f.read, { ...input, bytes: 4096 }, undefined, {}, 10000)
  expect(mcp.isError).not.toBe(true)
  const body = mcp.structuredContent as typeof cli
  expect(Buffer.byteLength(JSON.stringify(body.item))).toBeLessThanOrEqual(4096)
  expect(body.item.communications?.sources).toHaveLength(1)
  expect(body.item.communications?.sources[0]).toMatchObject({
    output_limited: true,
    restart_required: true,
    next_cursor: null,
  })
  expect(body.meta?.truncated).toBe(true)
  expect(body.item.meetings.map((m) => m.evidence.fingerprint)).toEqual(
    cli.item.meetings.map((m) => m.evidence.fingerprint),
  )
})

it("refuses a returned communications selection/window mismatch and unsolicited context", async () => {
  const f = await setup()
  for (const change of [
    (packet: Awaited<ReturnType<MeetingPreparationReader>>) => {
      if (packet.communications) packet.communications.query = "other"
    },
    (packet: Awaited<ReturnType<MeetingPreparationReader>>) => {
      if (packet.communications) present(packet.communications.sources[0]).selectionId = "foreign"
    },
    (packet: Awaited<ReturnType<MeetingPreparationReader>>) => {
      if (packet.communications) packet.communications.window.before++
    },
    (packet: Awaited<ReturnType<MeetingPreparationReader>>) => {
      const item = packet.communications?.items[0]
      if (item) item.ref = "msg:foreign/account/room/1"
    },
    (packet: Awaited<ReturnType<MeetingPreparationReader>>) => {
      const item = packet.communications?.items[0]
      if (item) item.at = 10000
    },
  ]) {
    const read: MeetingPreparationReader = async (...args) => {
      const p = await f.read(...args)
      change(p)
      return p
    }
    await expect(readMeetingPreparation(read, input, undefined, 10000)).rejects.toMatchObject({
      code: "invalid_response",
    })
  }
  const read: MeetingPreparationReader = async (id, request) =>
    f.read(id, { ...request, communications: { sources: [{ id: "project-chat" }], query: "launch" } })
  await expect(readMeetingPreparation(read, { series_id: "example-series" }, undefined, 10000)).rejects.toMatchObject({
    code: "invalid_response",
  })
})

it("refuses mandatory escaped coverage that cannot fit instead of silently dropping selected sources", async () => {
  const f = await contextEvidenceFixture()
  handles.push(f)
  const selections = ["one", "two"].map((id, i) => ({
    id,
    source: { ...f.sources.message, accountId: i + 1, account: "\u202e".repeat(341) },
  }))
  const service = createMeetingPreparationService(f.key, f.accountId, {
    meetings: f.store.meetings,
    upcoming: f.upcoming,
    communications: {
      selections,
      reader: {
        async read(req) {
          return {
            source: req.source,
            items: [],
            next: null,
            readBytes: 0,
            coverage: {
              available: false,
              index: "unknown",
              hasMore: false,
              hasUndated: false,
              completeness: "unknown",
              matching: "literal-words",
              consistency: "snapshot-per-page",
            },
          }
        },
      },
    },
  })
  const result = await callMeetingPreparationTool(
    service.prepare,
    {
      series_id: "example-series",
      bytes: 4096,
      communications: { sources: [{ id: "one" }, { id: "two" }], query: "launch" },
    },
    undefined,
    {},
    10000,
  )
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "validation_error" } } })
})
