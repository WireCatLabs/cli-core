import { afterEach, describe, expect, it } from "vitest"
import { readMeetingPreparation } from "../cli/meeting-preparation-read.js"
import { createMeetingPreparationService } from "../services/meeting-preparation.js"
import { preparationFixture } from "../testing/meeting-preparation.js"
import { callMeetingPreparationTool } from "./meeting-preparation.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})
const now = 10000
const windows = {
  series_id: "example-series",
  after: "1970-01-01T00:00:10Z",
  until: "1970-01-01T00:00:20Z",
  history_after: "1970-01-01T00:00:00Z",
}
const hidden = "\u200b".repeat(11000)
const fixture = async () => {
  const f = await preparationFixture()
  handles.push(f)
  const service = createMeetingPreparationService(f.key, f.accountId, {
    meetings: f.store.meetings,
    upcoming: f.upcoming,
  })
  return { ...f, read: service.prepare.bind(service) }
}

describe("meeting preparation after MCP text escaping", () => {
  it("trims escaped notes before accepted facts and meeting evidence, with consistent text and metadata", async () => {
    const f = await fixture()
    const note = await f.store.notes.addNote({ text: hidden, about: [f.project.ref] })
    const fact = await f.store.facts.add({
      type: "fact",
      statement: "Use the written checklist",
      subject: f.project.ref,
      by: "owner",
    })
    const args = { ...windows, bytes: 65536 }
    const cli = await readMeetingPreparation(f.read, args, undefined, now)
    expect(cli.item.notes?.items[0]).toMatchObject({ ref: note.ref, text: hidden })
    expect(cli.meta?.truncated).not.toBe(true)
    const result = await callMeetingPreparationTool(f.read, args, undefined, {}, now)
    expect(result.isError).not.toBe(true)
    const answer = result.structuredContent
    if (!("item" in answer)) throw new Error("Missing preparation item")
    expect(answer.item.notes).toMatchObject({ items: [], coverage: { output_limited: true } })
    expect(answer.item.knowledge?.items[0]?.ref).toBe(fact.ref)
    expect(answer.item.meetings).toHaveLength(1)
    expect(answer.item.coverage.output_limited).toBe(true)
    expect(answer.meta?.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(answer.item))).toBeLessThanOrEqual(args.bytes)
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(answer)
    const larger = await callMeetingPreparationTool(f.read, { ...args, bytes: 131072 }, undefined, {}, now)
    if (!("item" in larger.structuredContent)) throw new Error("Missing larger preparation item")
    const included = larger.structuredContent.item.notes?.items[0]
    expect(included?.ref).toBe(note.ref)
    expect(included?.text).toContain("\\u200b")
    expect(included?.text).not.toContain("\u200b")
    expect(larger.structuredContent.meta?.truncated).not.toBe(true)
  })

  it("reports cue byte counts for the representation each transport receives without mutating the source packet", async () => {
    const f = await fixture()
    const packet = await f.read("example-series", f.request)
    const cue = packet.items[0]?.evidence.items[0]
    if (!cue) throw new Error("Missing invented cue")
    cue.text = "Example\u200btext"
    const read = async () => packet
    const cli = await readMeetingPreparation(read, windows, undefined, now)
    const mcp = await callMeetingPreparationTool(read, windows, undefined, {}, now)
    if (!("item" in mcp.structuredContent)) throw new Error("Missing preparation item")
    const evidence = mcp.structuredContent.item.meetings[0]?.evidence
    expect(evidence?.items[0]?.text).toBe("Example\\u200btext")
    expect(evidence?.content_bytes).toBe(Buffer.byteLength(JSON.stringify(evidence?.items)))
    expect(cli.item.meetings[0]?.evidence.items[0]?.text).toBe("Example\u200btext")
    expect(cue.text).toBe("Example\u200btext")
  })

  it("refuses unfit escaped metadata through the error envelope instead of returning an oversized item", async () => {
    const f = await fixture()
    const packet = await f.read("example-series", f.request)
    if (!packet.series) throw new Error("Missing invented series")
    packet.series.title = hidden
    const result = await callMeetingPreparationTool(async () => packet, windows, undefined, {}, now)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: { code: "validation_error", message: expect.stringContaining("bytes") },
    })
    expect(result.structuredContent).not.toHaveProperty("item")
    expect(JSON.stringify(result.structuredContent)).not.toContain("\u200b")
  })
})
