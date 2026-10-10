import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { addMeetingCommands, type MeetingCommandDeps } from "./cli/index.js"
import { callMeetingTool, meetingTools } from "./mcp/index.js"
import { meetingShow, meetingsList, meetingsSearch } from "./reads.js"
import { fakeMeetingSource, memoryMeetingStore, sampleMeeting } from "./testing/index.js"

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
  it("lists, shows, reads transcripts, searches participants/text and lists events", async () => {
    const { run, outputs, d } = await setup()
    await run([
      "meetings",
      "list",
      "--json",
      "--limit",
      "1",
      "--page",
      "1",
      "--since",
      "1970-01-01",
      "--until",
      "1970-01-02",
    ])
    expect(outputs[0]).toMatchObject({ format: "json", value: { page: 1, limit: 1, hasMore: false } })
    await run(["meetings", "show", String(d.meeting.id)])
    expect(outputs[1]).toMatchObject({ format: "text", value: { meeting: { id: d.meeting.id } } })
    await run(["meetings", "transcript", String(d.meeting.id), "--jsonl"])
    expect(outputs[2]).toMatchObject({ format: "jsonl", value: { items: d.transcripts } })
    await run(["meetings", "search", "example"])
    await run(["meetings", "people", "Alice"])
    expect(outputs[4]).toMatchObject({ value: { items: d.participants } })
    await run(["events", "list"])
    expect(outputs[5]).toMatchObject({ value: { items: [] } })
  })
  it("pulls and imports through injected sources and file readers", async () => {
    const { run, outputs } = await setup()
    await run(["meetings", "pull", "--since", "1970-01-01"])
    await run(["meetings", "pull"])
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
      ["meetings", "list", "--since", "bad"],
      ["meetings", "show", "999"],
      ["meetings", "list", "--json", "--jsonl"],
      ["meetings", "search", " "],
    ])
      await expect(run(args)).rejects.toThrow()
    const unconfigured = await setup({ source: undefined, readFiles: undefined })
    await expect(unconfigured.run(["meetings", "pull"])).rejects.toThrow(/source/)
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
      since: 0,
      until: 2000,
    })
    expect(list.structuredContent).toEqual(
      await meetingsList(store, { accountId: 1, limit: 1, since: 0, until: 2000 }, 1),
    )
    const show = await callMeetingTool(store, "meeting_show", { meeting: d.meeting.id })
    expect(show.structuredContent).toEqual(d)
    expect(JSON.parse(show.content[0]?.text ?? "null")).toEqual(d)
    expect(
      (await callMeetingTool(store, "meeting_transcript", { meeting: d.meeting.id })).structuredContent,
    ).toMatchObject({ items: d.transcripts })
    expect((await callMeetingTool(store, "meetings_search", { query: "example" })).structuredContent).toEqual(
      await meetingsSearch(store, "example"),
    )
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
      ["meetings_search", { query: " " }],
      ["meetings_search", { query: 1 }],
      ["meetings_list", { since: "bad" }],
      ["meetings_list", { until: Number.NaN }],
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
      error: { code: "generic_failure", message: "Read failed" },
    })
    store.meetings = async () => {
      throw "failure"
    }
    expect((await callMeetingTool(store, "meetings_list", {})).structuredContent).toEqual({
      error: { code: "generic_failure", message: "Meeting read failed" },
    })
  })
})
it("pagination detects the next page and readers validate arguments", async () => {
  const store = memoryMeetingStore()
  await store.saveMeeting(sampleMeeting())
  const input = sampleMeeting()
  input.meeting.externalId = "second"
  await store.saveMeeting(input)
  expect((await meetingsList(store, { limit: 1 })).hasMore).toBe(true)
  expect((await meetingsList(store, { limit: 1 }, 2)).hasMore).toBe(false)
  await expect(meetingShow(store, -1)).rejects.toThrow()
  await expect(meetingsList(store, {}, 0)).rejects.toThrow()
  const saved = await store.meeting((await store.meetings())[0]?.id ?? 0)
  if (!saved) throw new Error("Missing meeting")
  await expect(meetingShow(store, saved.meeting.id, 2)).rejects.toThrow(/not found/)
})
