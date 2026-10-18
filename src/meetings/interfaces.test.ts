import { describeProgram, flatten } from "@wirecat/cli-base/commands"
import { itemEnvelopeSchema, listEnvelopeSchema } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { meetingDetails, meetingSummary, meetingTranscript } from "./answers.js"
import { addMeetingCommands, addMeetingProjectEvidenceCommand, type MeetingCommandDeps } from "./cli/index.js"
import { meeting } from "./item.js"
import { callMeetingTool, meetingTools } from "./mcp/index.js"
import { meetingDetailsAnswer, meetingsList, meetingsQuery } from "./reads.js"
import { fakeMeetingSource, memoryMeetingStore, sampleMeeting } from "./testing/index.js"

const meta = { run_id: "run", duration_ms: 0, complete: true }

const setup = async (overrides: Partial<MeetingCommandDeps> = {}) => {
  const store = memoryMeetingStore()
  const d = await store.saveMeeting(sampleMeeting())
  const outputs: { value: unknown; format: string }[] = []
  const deps: MeetingCommandDeps = {
    store,
    accountId: 1,
    source: fakeMeetingSource(),
    readFiles: async () => [],
    now: () => 4000,
    write: (value, format) => outputs.push({ value, format }),
    ...overrides,
  }
  const run = async (args: string[]) => {
    const program = new Command().exitOverride().configureOutput({ writeErr() {}, writeOut() {} })
    addMeetingCommands(program, deps)
    await program.parseAsync(args, { from: "user" })
  }
  return { store, d, outputs, run }
}
describe("meeting commands", () => {
  it("declares effects on every command it registers, and none on a group that only holds commands", () => {
    const program = new Command("meet")
    addMeetingCommands(program, { store: memoryMeetingStore(), accountId: 1, write() {} })
    addMeetingProjectEvidenceCommand(program, { read: async () => ({}) as never, signal: () => undefined, output() {} })
    const effects = Object.fromEntries(
      flatten(describeProgram(program)).map((info) => [info.path.join(" "), info.effects ?? null]),
    )

    expect(effects).toEqual({
      meetings: null,
      "meetings list": { remote: "none", local: "read" },
      "meetings show": { remote: "none", local: "read" },
      "meetings transcript": { remote: "none", local: "read" },
      "meetings summary": { remote: "none", local: "read" },
      "meetings export": { remote: "none", local: "write" },
      "meetings people": { remote: "none", local: "read" },
      "meetings sync": { remote: "read", local: "write" },
      "meetings import": { remote: "none", local: "write" },
      "meetings projects": null,
      "meetings projects evidence": { remote: "none", local: "read" },
      events: null,
      "events list": { remote: "none", local: "read" },
    })
  })
  it("lists, shows, reads transcripts, finds participants and lists events", async () => {
    const { run, outputs, d } = await setup()
    await run(["meetings", "list", "--json", "--limit", "1", "--page", "1", "started_at:[1970-01-01 TO 1970-01-02]"])
    expect(outputs[0]).toMatchObject({ format: "json", value: { page: { limit: 1, has_more: false } } })
    expect(v.parse(listEnvelopeSchema(meeting), { ...(outputs[0]?.value as object), meta })).toMatchObject({
      items: [{ ref: `meeting:1/${d.meeting.id}`, id: String(d.meeting.id), provider: "memory", account: "1" }],
    })
    await run(["meetings", "list", "started_at>=1970-01-02", "--json"])
    expect(outputs.pop()).toMatchObject({ value: { items: [] } })
    await run(["meetings", "show", String(d.meeting.id)])
    expect(outputs[1]).toMatchObject({ format: "text" })
    expect(v.parse(itemEnvelopeSchema(meetingDetails), { ...(outputs[1]?.value as object), meta }).item).toMatchObject({
      ref: `meeting:1/${d.meeting.id}`,
      participants: [{ name: "Alice Example" }],
    })
    await run(["meetings", "transcript", String(d.meeting.id), "--jsonl"])
    expect(outputs[2]).toMatchObject({ format: "jsonl" })
    const transcripts = v.parse(listEnvelopeSchema(meetingTranscript), { ...(outputs[2]?.value as object), meta })
    expect(transcripts.items[0]?.lines[0]).toMatchObject({ offset_ms: d.transcripts[0]?.rows[0]?.startMs })
    await run(["meetings", "people", "Alice"])
    expect(outputs[3]).toMatchObject({ value: { items: d.participants } })
    await run(["events", "list"])
    expect(outputs[4]).toMatchObject({ value: { items: [] } })
  })
  it("pulls and imports through injected sources and file readers", async () => {
    const { run, outputs } = await setup()
    await run(["meetings", "sync", "--since-time", "1970-01-01"])
    await run(["meetings", "sync"])
    await run(["meetings", "import", "example-folder"])
    expect(outputs[0]).toMatchObject({ value: { meetings: 1 } })
    expect(outputs[2]).toMatchObject({ value: { meetings: 0 } })
    const noClock = await setup({ now: undefined })
    await noClock.run(["meetings", "import", "example-folder"])
  })
  it("rejects invalid options, missing resources and unavailable dependencies", async () => {
    const { run } = await setup()
    for (const args of [
      ["meetings", "list", "--limit", "0"],
      ["meetings", "list", "--limit", "9007199254740992"],
      ["meetings", "list", "--since-time", "2026-01-01"],
      ["meetings", "list", "started_at>bad"],
      ["meetings", "list", "title"],
      ["meetings", "show", "999"],
      ["meetings", "list", "--json", "--jsonl"],
    ])
      await expect(run(args)).rejects.toThrow()
    const unconfigured = await setup({ source: undefined, readFiles: undefined })
    await expect(unconfigured.run(["meetings", "sync"])).rejects.toThrow(/source/)
    await expect(unconfigured.run(["meetings", "import", "example-folder"])).rejects.toThrow(/reader/)
    const badFiles = await setup({
      readFiles: async () => [{ meeting: { ...sampleMeeting().meeting, accountId: 2 }, content: "WEBVTT" }],
    })
    await expect(badFiles.run(["meetings", "import", "example-folder"])).rejects.toThrow(/account/)
  })
})
describe("MCP meeting reads", () => {
  it("provides schemas and structured read results consistent with the CLI", async () => {
    const { store, d } = await setup()
    expect(meetingTools.every((t) => t.annotations.readOnlyHint && !t.inputSchema.additionalProperties)).toBe(true)
    const list = await callMeetingTool(store, "meetings_list", {
      account_id: 1,
      limit: 1,
      page: 1,
      query: "started_at:[1970-01-01 TO 1970-01-02]",
    })
    expect(list.structuredContent).toEqual(
      await meetingsList(
        store,
        { accountId: 1, limit: 1, query: meetingsQuery("started_at:[1970-01-01 TO 1970-01-02]") },
        1,
      ),
    )
    expect(list.structuredContent).toMatchObject({ items: [{ id: String(d.meeting.id) }] })
    const show = await callMeetingTool(store, "meeting_show", { meeting: d.meeting.id })
    expect(show.structuredContent).toEqual(await meetingDetailsAnswer(store, d.meeting.id))
    expect(JSON.parse(show.content[0]?.text ?? "null")).toEqual(show.structuredContent)
    expect(show.structuredContent).not.toHaveProperty("next_steps")
    const transcript = await callMeetingTool(store, "meeting_transcript", { meeting: d.meeting.id })
    expect(
      v.parse(listEnvelopeSchema(meetingTranscript), { ...transcript.structuredContent, meta }).items,
    ).toHaveLength(d.transcripts.length)
    const summary = await callMeetingTool(store, "meeting_summary", { meeting: d.meeting.id })
    expect(() => v.parse(listEnvelopeSchema(meetingSummary), { ...summary.structuredContent, meta })).not.toThrow()
    expect(
      (await callMeetingTool(store, "meeting_people", { query: "Alice", account_id: 1 })).structuredContent,
    ).toMatchObject({ items: d.participants })
    expect((await callMeetingTool(store, "meetings_list", {})).structuredContent).toEqual(await meetingsList(store))
  })
  it("refuses unknown names/arguments and malformed inputs before reads", async () => {
    const store = memoryMeetingStore()
    for (const [name, args] of [
      ["unknown", {}],
      ["meetings_list", null],
      ["meetings_list", []],
      ["meetings_list", { extra: true }],
      ["meetings_list", { constructor: "invalid" }],
      ["meeting_show", {}],
      ["meeting_show", { meeting: "1" }],
      ["meeting_show", { meeting: 0 }],
      ["meetings_search", { query: "example" }],
      ["meeting_people", { query: " " }],
      ["meetings_list", { since: 0 }],
      ["meetings_list", { query: "nofield:1" }],
      ["meeting_show", { meeting: 999 }],
    ] as [string, unknown][]) {
      const result = await callMeetingTool(store, name, args)
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toHaveProperty("error")
    }
    store.meetings = async () => {
      throw new Error("Read failed")
    }
    expect((await callMeetingTool(store, "meetings_list", {})).structuredContent).toEqual({
      error: {
        code: "internal_error",
        reason: "command.crashed",
        message: "the command failed; this is a bug",
        retry: { safe: false },
      },
    })
    store.meetings = async () => {
      throw "failure"
    }
    expect((await callMeetingTool(store, "meetings_list", {})).structuredContent).toEqual({
      error: {
        code: "internal_error",
        reason: "command.crashed",
        message: "the command failed; this is a bug",
        retry: { safe: false },
      },
    })
  })
})
it("pagination detects the next page and readers validate arguments", async () => {
  const store = memoryMeetingStore()
  await store.saveMeeting(sampleMeeting())
  const input = sampleMeeting()
  input.meeting.externalId = "second"
  await store.saveMeeting(input)
  const first = await meetingsList(store, { limit: 1 })
  expect(first.page.has_more).toBe(true)
  expect(first.next).toMatchObject([{ step: "page.next", command: "meetings list", args: { page: 2, limit: 1 } }])
  expect((await meetingsList(store, { limit: 1 }, 2)).page.has_more).toBe(false)
  await expect(meetingDetailsAnswer(store, -1)).rejects.toThrow()
  await expect(meetingsList(store, {}, 0)).rejects.toThrow()
  const saved = await store.meeting((await store.meetings())[0]?.id ?? 0)
  if (!saved) throw new Error("Missing meeting")
  await expect(meetingDetailsAnswer(store, saved.meeting.id, 2)).rejects.toThrow(/not found/)
})
