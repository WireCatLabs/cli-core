import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, expect, it, vi } from "vitest"
import { addMeetingPassageCommand } from "../meetings/cli/index.js"
import { callMeetingPassageTool, meetingPassageTool } from "../meetings/mcp/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { openCache } from "../store/open.js"
import { openStore } from "../store/store.js"
import { readMeetingEvidence } from "./meeting-evidence.js"
import { readMeetingHitContext } from "./meeting-hit-context.js"
import { formatMeetingPassage, readMeetingPassage } from "./meeting-passage-format.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close()
})
const fixture = async (provider = "example") => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-context-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path }, now: () => 3000 })
  opened.push(store)
  const accountId = await store.saveAccount({ provider, account: "AliceExample" }, { name: "Alice Example" })
  const foreign = await store.saveAccount({ provider: "second-example", account: "BobSample" }, { name: "Bob Sample" })
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  const first = input.transcripts[0].rows[0]
  const generated = [0, 3, 9, 20, 24, 40, 80].map((position, i) => ({
    ...first,
    position,
    startMs: i * 1000,
    endMs: (i + 1) * 1000,
    text: `Alice Example context ${position}`,
    speakerParticipantPosition: null,
  }))
  const [head, ...tail] = generated
  if (!head) throw Error("missing invented cue")
  input.transcripts[0].rows = [head, ...tail]
  const saved = await store.meetings.saveMeeting(input)
  const transcript = saved.transcripts[0]?.transcript.id
  if (!transcript) throw Error("missing invented transcript")
  const ref = `meeting:${accountId}/${saved.meeting.id}/${transcript}/20`
  return { store, accountId, foreign, input, saved, ref, path }
}
it("search hit refs open exact sparse-position context through both shared CLI and MCP", async () => {
  const f = await fixture()
  await f.store.meetings.indexSearch({ accountId: f.accountId })
  const hit = (await f.store.meetings.searchHits("context 20", { accountId: f.accountId })).items[0]
  expect(hit?.ref).toBe(f.ref)
  const rootRef = `meeting:${f.accountId}/${f.saved.meeting.id}`
  const summary = (await f.store.meetings.searchHits("overview", { accountId: f.accountId })).items[0]
  expect(summary?.ref).toBe(rootRef)
  const read = (reference: string, options: Parameters<typeof readMeetingPassage>[3]) =>
    readMeetingPassage(f.store.meetings, f.accountId, reference, options)
  const program = new Command("example")
  program.option("--json")
  program.command("meetings")
  const output = vi.fn()
  addMeetingPassageCommand(program, { read, signal: () => undefined, output })
  await program.parseAsync(
    ["meetings", "passage", f.ref, "--before-n", "2", "--after-n", "1", "--format", "markdown"],
    {
      from: "user",
    },
  )
  const result = output.mock.calls[0]?.[0]
  expect(result?.packet.items.map((cue: { position: number }) => cue.position)).toEqual([3, 9, 20, 24])
  expect(result?.content).toContain(`\`${f.ref}\``)
  const mcp = await callMeetingPassageTool(read, { reference: f.ref, before: 2, after: 1, format: "markdown" })
  expect(mcp.structuredContent).toEqual(result?.packet)
  expect(mcp.content).toEqual([{ type: "text", text: result?.content }])
  expect(meetingPassageTool.inputSchema.properties).not.toHaveProperty("account_id")
})
it("handles transcript boundaries, zero context and inclusive continuation anchors", async () => {
  const f = await fixture()
  const middle = await readMeetingHitContext(f.store.meetings, f.accountId, f.ref, { before: 1, after: 1 })
  expect(middle.coverage).toMatchObject({
    before: 1,
    after: 1,
    has_before: true,
    has_after: true,
    continuation: "anchor-inclusive",
    archive_completeness: "unknown",
  })
  const next = await readMeetingHitContext(f.store.meetings, f.accountId, middle.coverage.after_ref as string, {
    before: 0,
    after: 2,
  })
  expect(next.items.map((cue) => cue.position)).toEqual([24, 40, 80])
  expect(next.coverage.has_after).toBe(false)
  const first = await readMeetingHitContext(f.store.meetings, f.accountId, f.ref.replace(/20$/, "0"), {
    before: 3,
    after: 0,
  })
  expect(first.items.map((cue) => cue.position)).toEqual([0])
  expect(first.coverage.has_before).toBe(false)
  const only = await readMeetingHitContext(f.store.meetings, f.accountId, f.ref, { before: 0, after: 0 })
  expect(only.items.map((cue) => cue.position)).toEqual([20])
  expect(only.coverage).toMatchObject({ has_before: true, has_after: true })
})
it("retains old revisions and checks an anchor fingerprint rather than drifting to a replacement", async () => {
  const f = await fixture()
  const original = await readMeetingEvidence(f.store.meetings, f.accountId, f.ref)
  f.input.transcripts[0].contentHash = "invented-correction"
  const corrected = f.input.transcripts[0].rows[3]
  if (!corrected) throw Error("missing invented correction")
  corrected.text = "Corrected invented statement"
  await f.store.meetings.saveMeeting(f.input)
  const old = await readMeetingHitContext(f.store.meetings, f.accountId, f.ref, {
    expected_fingerprint: original.items[0]?.fingerprint,
  })
  expect(old.revision).toBe("superseded")
  expect(old.items.find((cue) => cue.ref === f.ref)?.text).toBe("Alice Example context 20")
  expect(formatMeetingPassage(old, "text")).toContain("superseded")
  await expect(
    readMeetingHitContext(f.store.meetings, f.accountId, f.ref, { expected_fingerprint: "0".repeat(64) }),
  ).rejects.toMatchObject({ code: "validation_error", details: { reason: "stale_meeting_cue" } })
})
it("trims contiguous sides by UTF8 bytes while preserving the target and explicit continuation", async () => {
  const f = await fixture()
  const only = await readMeetingHitContext(f.store.meetings, f.accountId, f.ref, { before: 0, after: 0 })
  const clipped = await readMeetingHitContext(f.store.meetings, f.accountId, f.ref, {
    before: 3,
    after: 3,
    bytes: only.content_bytes,
  })
  expect(clipped.items.map((cue) => cue.position)).toEqual([20])
  expect(clipped.coverage).toMatchObject({ truncated_by: "bytes", has_before: true, has_after: true })
  expect(Buffer.byteLength(JSON.stringify(clipped.items), "utf8")).toBe(clipped.content_bytes)
  await expect(readMeetingHitContext(f.store.meetings, f.accountId, f.ref, { bytes: 2 })).rejects.toMatchObject({
    code: "validation_error",
  })
  const db = await openCache(f.path)
  opened.push(db)
  db.prepare("UPDATE meeting_transcript_rows SET text=? WHERE meeting_transcript_id=? AND position=9").run(
    "é".repeat(10000),
    f.saved.transcripts[0]?.transcript.id as number,
  )
  expect(
    (await readMeetingHitContext(f.store.meetings, f.accountId, f.ref, { before: 0, after: 0, max_read_bytes: 1024 }))
      .items,
  ).toHaveLength(1)
  await expect(
    readMeetingHitContext(f.store.meetings, f.accountId, f.ref, { before: 1, after: 0, max_read_bytes: 1024 }),
  ).rejects.toMatchObject({ code: "validation_error" })
})
it("rejects invalid scopes and budgets before adapter reads, and deleted/missing anchors", async () => {
  const f = await fixture()
  const read = vi.fn(f.store.meetings.transcriptContext)
  const port = { transcriptContext: read }
  for (const options of [
    { before: -1 },
    { after: 1000 },
    { before: 999, after: 1 },
    { bytes: 1 },
    { max_read_bytes: 0 },
    { expected_fingerprint: "bad" },
  ])
    await expect(readMeetingHitContext(port, f.accountId, f.ref, options)).rejects.toMatchObject({
      code: "validation_error",
    })
  await expect(readMeetingHitContext(port, f.foreign, f.ref)).rejects.toMatchObject({ code: "not_found" })
  await expect(readMeetingHitContext(port, 0, f.ref)).rejects.toMatchObject({ code: "validation_error" })
  await expect(
    readMeetingHitContext(port, f.accountId, `meeting:${f.accountId}/${f.saved.meeting.id}`),
  ).rejects.toMatchObject({ code: "validation_error" })
  const controller = new AbortController()
  controller.abort()
  await expect(readMeetingHitContext(port, f.accountId, f.ref, { signal: controller.signal })).rejects.toMatchObject({
    code: "cancelled",
  })
  expect(read).not.toHaveBeenCalled()
  await expect(readMeetingHitContext({}, f.accountId, f.ref)).rejects.toMatchObject({ code: "configuration_error" })
  await expect(readMeetingHitContext(f.store.meetings, f.accountId, f.ref.replace(/20$/, "21"))).rejects.toMatchObject({
    code: "not_found",
  })
  f.input.meeting.deletedAt = 4000
  await f.store.meetings.saveMeeting(f.input)
  await expect(readMeetingHitContext(f.store.meetings, f.accountId, f.ref)).rejects.toMatchObject({ code: "not_found" })
})
it("does not trust a malformed provider's scope, ordering or bounds", async () => {
  const f = await fixture("calendar-example")
  const scope = {
    accountId: f.accountId,
    meetingId: f.saved.meeting.id,
    transcriptId: f.saved.transcripts[0]?.transcript.id as number,
    position: 20,
    before: 1,
    after: 1,
  }
  const page = await f.store.meetings.transcriptContext(scope)
  for (const changed of [
    { meeting: { ...page.meeting, accountId: f.foreign } },
    { rows: [...page.rows].reverse() },
    { rows: [] },
    { rows: [...page.rows, ...page.rows] },
    { hasBefore: undefined },
  ]) {
    const port = { transcriptContext: vi.fn(async () => ({ ...page, ...changed })) }
    await expect(
      readMeetingHitContext(port as unknown as Parameters<typeof readMeetingHitContext>[0], f.accountId, f.ref, {
        before: 1,
        after: 1,
      }),
    ).rejects.toThrow()
  }
  const actual = await readMeetingHitContext(f.store.meetings, f.accountId, f.ref, { before: 1, after: 1 })
  expect(actual.items.map((cue) => cue.position)).toEqual([9, 20, 24])
})
it("renders plain and Markdown passages without executable HTML, terminal escapes or missing coverage", async () => {
  const f = await fixture()
  const packet = await readMeetingHitContext(f.store.meetings, f.accountId, f.ref, { before: 0, after: 0 })
  const cue = packet.items[0]
  if (!cue) throw Error("missing invented passage")
  cue.text = "<script>alert(1)</script> [click](https://example.com)\n```\n\u001b[2J"
  cue.speaker_name = "Alice\rExample"
  const md = formatMeetingPassage(packet, "markdown")
  expect(md).toContain("&lt;script&gt;")
  expect(md).not.toContain("<script>")
  expect(md).not.toContain("\u001b")
  expect(md).toContain("\\u{1b}")
  expect(md).toContain("archive: unknown")
  expect(md).toContain("00:00:03–00:00:04")
  expect(formatMeetingPassage(packet, "text")).toContain(packet.target_ref)
  await expect(
    readMeetingPassage(f.store.meetings, f.accountId, f.ref, { format: "yaml" as "text" }),
  ).rejects.toMatchObject({ code: "validation_error" })
  expect(() => formatMeetingPassage(packet, "text", 10)).toThrow()
  const evidence = await readMeetingEvidence(
    f.store.meetings,
    f.accountId,
    `meeting:${f.accountId}/${f.saved.meeting.id}`,
  )
  const rendered = formatMeetingPassage(evidence, "markdown")
  expect(rendered).toContain("Source:")
  expect(
    formatMeetingPassage(
      { ...evidence, items: [], coverage: { ...evidence.coverage, included: 0, hasMore: true, truncatedBy: "bytes" } },
      "text",
    ),
  ).toContain("No cues included; check coverage")
})
it("keeps CLI JSON structured and refuses MCP overrides, malformed limits and cancellation", async () => {
  const f = await fixture()
  const read = vi.fn((reference: string, options: Parameters<typeof readMeetingPassage>[3]) =>
    readMeetingPassage(f.store.meetings, f.accountId, reference, options),
  )
  const program = new Command("example").option("--json")
  program.command("meetings")
  const output = vi.fn()
  addMeetingPassageCommand(program, { read, signal: () => undefined, output })
  await program.parseAsync(["--json", "meetings", "passage", f.ref, "--before-n", "0", "--after-n", "0"], {
    from: "user",
  })
  expect(output.mock.calls[0]?.[1]).toBe("json")
  expect(JSON.parse(output.mock.calls[0]?.[0].content).target_ref).toBe(f.ref)
  for (const input of [
    null,
    {},
    [],
    { reference: f.ref, account_id: f.foreign },
    { reference: f.ref, before: "3" },
    { reference: f.ref, format: "yaml" },
  ])
    expect(await callMeetingPassageTool(read, input)).toHaveProperty("isError", true)
  const controller = new AbortController()
  controller.abort()
  const blocked = vi.fn()
  expect(await callMeetingPassageTool(blocked, { reference: f.ref }, controller.signal)).toHaveProperty("isError", true)
  expect(blocked).not.toHaveBeenCalled()
})
