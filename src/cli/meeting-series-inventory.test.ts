import { describeProgram, flatten } from "@wirecat/cli-base/commands"
import { itemEnvelopeSchema } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import * as v from "valibot"
import { expect, it, vi } from "vitest"
import { meetingSeriesInventory } from "../entities/index.js"
import { callMeetingSeriesInventoryTool } from "../mcp/meeting-series-inventory.js"
import { createMeetingSeriesInventoryReader } from "../meetings/index.js"
import { addMeetingSeriesInventoryCommand } from "./meeting-series-inventory-command.js"
import { readMeetingSeriesInventory } from "./meeting-series-inventory-read.js"

const now = Date.parse("2026-10-18T00:00:00Z")
const fixture = (provider = "example-calendar") => {
  const port = {
    read: vi.fn(async (context: import("../meetings/index.js").MeetingSeriesInventoryRead) => ({
      scope: context.scope,
      after: context.after,
      until: context.until,
      items:
        context.cursor === undefined
          ? [
              {
                meetingId: "past-recurring",
                title: "Harbour Example",
                kind: "recurring" as const,
                scheduledStartAt: now - 86400000,
              },
              { meetingId: "undated-example", title: null, kind: "unscheduled" as const, scheduledStartAt: null },
            ]
          : [],
      nextCursor: context.cursor === undefined ? "next-example" : null,
      coverage: { selection: "provider-inventory" as const, partial: false },
    })),
  }
  const service = createMeetingSeriesInventoryReader({ provider, account: "AliceExample" }, port)
  const read = vi.fn(service.page.bind(service))
  return { port, read }
}

it.each(["example-calendar", "example-conference"])(
  "CLI/MCP preserve unverified %s inventory and frozen continuation",
  async (provider) => {
    const f = fixture(provider)
    const program = new Command("example").exitOverride()
    program.command("meetings")
    const output = vi.fn()
    addMeetingSeriesInventoryCommand(program, { read: f.read, output, signal: () => undefined, now: () => now })
    await program.parseAsync(["meetings", "scheduled", "--limit", "2"], { from: "user" })
    const cli = v.parse(itemEnvelopeSchema(meetingSeriesInventory), output.mock.calls[0]?.[0])
    const result = await callMeetingSeriesInventoryTool(f.read, { limit: 2 }, undefined, {}, now)
    const mcp = v.parse(itemEnvelopeSchema(meetingSeriesInventory), result.structuredContent)
    expect(mcp.item).toEqual(cli.item)
    expect(mcp.item).toMatchObject({
      scope: { provider, account: "AliceExample" },
      after: "2026-10-18T00:00:00.000Z",
      until: "2026-10-25T00:00:00.000Z",
      items: [
        { meeting_id: "past-recurring", scheduled_start_at: "2026-10-17T00:00:00.000Z" },
        { scheduled_start_at: null },
      ],
      page: { has_more: true },
      coverage: {
        undated: 1,
        date_hints_outside_window: 1,
        occurrence_proof: "not-read",
        calendar_completeness: "unknown",
      },
    })
    expect(mcp.meta).toMatchObject({ complete: true, truncated: true })
    if (mcp.item.page.mode !== "cursor") throw Error("missing cursor page")
    const resumed = await readMeetingSeriesInventory(
      f.read,
      { after: mcp.item.after, until: mcp.item.until, cursor: mcp.item.page.next_cursor, limit: 2 },
      undefined,
      now + 86400000,
    )
    expect(resumed.item).toMatchObject({
      items: [],
      page: { has_more: false },
      after: mcp.item.after,
      until: mcp.item.until,
    })
    expect(f.port.read).toHaveBeenCalledTimes(3)
    const command = flatten(describeProgram(program)).find((row) => row.path.join(" ") === "meetings scheduled")
    expect(command).toMatchObject({ mcp: false, offline: false, effects: { remote: "read", local: "read" } })
  },
)

it.each([
  [{ provider: "other" }, "provider"],
  [{ limit: 101 }, "limit"],
  [{ bytes: "2048" }, "bytes"],
  [{ after: "2026-02-30T00:00:00Z" }, "after"],
  [{ after: "2026-10-25T00:00:00Z", until: "2026-10-18T00:00:00Z" }, "after/until"],
  [{ cursor: "abc" }, "cursor"],
  [{ cursor: Buffer.from("null").toString("base64url") }, "cursor"],
  [{ cursor: Buffer.from([0xff]).toString("base64url") }, "cursor"],
] as const)("rejects malformed raw fields before host I/O: %j", async (input, field) => {
  const f = fixture()
  const result = await callMeetingSeriesInventoryTool(f.read, input, undefined, {}, now)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.structuredContent)).toContain("validation_error")
  expect(JSON.stringify(result.structuredContent)).toContain(field)
  expect(f.read).not.toHaveBeenCalled()
})

it("refuses output bytes instead of dropping candidates or advancing a provider page", async () => {
  const f = fixture()
  const ordinary = await f.read({ after: now, until: now + 86400000 })
  const first = ordinary.items[0]
  if (!first) throw Error("missing invented candidate")
  const oversized = {
    ...ordinary,
    items: [{ ...first, title: "a".repeat(3000) }],
    limits: { ...ordinary.limits, bytes: 2048 },
  }
  const read = vi.fn(async () => oversized)
  await expect(
    readMeetingSeriesInventory(
      read,
      { after: new Date(now).toISOString(), until: new Date(now + 86400000).toISOString(), bytes: 2048 },
      undefined,
      now,
    ),
  ).rejects.toMatchObject({ code: "validation_error" })
  expect(read).toHaveBeenCalledOnce()
  expect(oversized.items).toHaveLength(1)
})

it("refuses foreign windows, unbounded rows and cancellation", async () => {
  const f = fixture()
  const packet = await f.read({ after: now, until: now + 7 * 86400000 })
  const first = packet.items[0]
  if (!first) throw Error("missing invented candidate")
  for (const change of [
    { after: 0 },
    { items: Array.from({ length: 101 }, () => first) },
    { coverage: { ...packet.coverage, occurrenceProof: "verified" } },
    { items: [{ ...first, scheduledStartAt: Number.NaN }] },
  ]) {
    const read = vi.fn(async () => ({ ...packet, ...change }) as typeof packet)
    await expect(readMeetingSeriesInventory(read, {}, undefined, now)).rejects.toMatchObject({
      code: "invalid_response",
    })
    expect(read).toHaveBeenCalledOnce()
  }
  const controller = new AbortController()
  controller.abort()
  const read = vi.fn()
  const result = await callMeetingSeriesInventoryTool(read, {}, controller.signal, {}, now)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.structuredContent)).toContain("cancelled")
  expect(read).not.toHaveBeenCalled()
})
