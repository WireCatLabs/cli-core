import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { addMeetingCommands } from "./cli/index.js"
import { exportMeeting, serializeVtt } from "./export.js"
import { callMeetingTool } from "./mcp/index.js"
import { meetingSummary, meetingTranscript } from "./reads.js"
import type { MeetingSave } from "./store.js"
import { memoryMeetingStore, sampleMeeting } from "./testing/index.js"
import { parseVtt } from "./vtt.js"

const present = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("missing fixture")
  return value
}

const corrected = async () => {
  const store = memoryMeetingStore()
  const input = sampleMeeting()
  const first = await store.saveMeeting(input)
  input.now += 1000
  input.transcripts[0].contentHash = "corrected-example-hash"
  input.transcripts[0].rows[0].text = "Corrected example text."
  const second = await store.saveMeeting(input)
  return { store, first, second }
}
describe("archive reads", () => {
  it("makes control characters visible and keeps titles and speaker labels on one line", async () => {
    const store = memoryMeetingStore()
    const input = sampleMeeting()
    input.meeting.title = "Example\nheading"
    input.meeting.description = `Example ${String.fromCharCode(27)}[31mtext ${String.fromCodePoint(0x202e)}ending`
    input.transcripts[0].rows[0].speakerName = "Alice\nExample"
    const saved = await store.saveMeeting(input)
    const result = await exportMeeting(store, saved.meeting.id, { format: "markdown" })
    expect(result.content).not.toContain(String.fromCharCode(27))
    expect(result.content).not.toContain(String.fromCodePoint(0x202e))
    expect(result.content).toContain("\\\\x1b")
    expect(result.content).toContain("\\\\u202e")
    expect(result.content.split("\n")[0]).toBe("# Example\\\\x0aheading")
    expect(result.content).toContain("Alice\\\\x0aExample")
  })
  it("orders stored cue positions for both exports without mutating stored row order", async () => {
    const store = memoryMeetingStore()
    const saved = await store.saveMeeting(sampleMeeting())
    const details = structuredClone(saved)
    const first = present(details.transcripts[0])
    const original = present(first.rows[0])
    first.rows = [
      { ...original, id: original.id + 1, position: 1, startMs: 2000, endMs: 3000, text: "Second example line" },
      original,
    ]
    store.meeting = async () => details
    const vtt = await exportMeeting(store, saved.meeting.id, { format: "vtt" })
    expect(parseVtt(vtt.content).map((line) => line.text)).toEqual(["Ship the example plan.", "Second example line"])
    const markdown = await exportMeeting(store, saved.meeting.id, { format: "markdown" })
    expect(markdown.content.indexOf("Ship the example plan")).toBeLessThan(
      markdown.content.indexOf("Second example line"),
    )
    expect(first.rows.map((row) => row.position)).toEqual([1, 0])
  })
  it("keeps current reads separate from retained transcript history and excludes deleted versions", async () => {
    const { store, second } = await corrected()
    const id = second.meeting.id
    expect((await meetingTranscript(store, id, 1)).items).toHaveLength(1)
    expect((await meetingTranscript(store, id, 1, { history: true })).items).toHaveLength(2)
    expect((await meetingSummary(store, id, 1)).items[0]?.content).toBe("Example content")
    const hidden = structuredClone(second)
    present(hidden.transcripts[0]).transcript.deletedAt = 5000
    store.meeting = async () => hidden
    expect((await meetingTranscript(store, id, 1, { history: true })).items).toHaveLength(1)
    await expect(meetingSummary(store, id, 2)).rejects.toMatchObject({ code: "not_found" })
  })

  it("exports current Markdown and explicitly selected historical VTT without exposing another account", async () => {
    const { store, first, second } = await corrected()
    const current = await exportMeeting(store, second.meeting.id, { accountId: 1, format: "markdown" })
    expect(current.filename).toBe(`meeting-${second.meeting.id}.md`)
    expect(current.content).toContain("Corrected example text\\.")
    expect(current.content).not.toContain("Ship the example plan")
    expect(current.content).toContain("Example content")
    expect(current.content).not.toContain("Example overview")
    const transcriptId = present(first.transcripts[0]).transcript.id
    const historic = await exportMeeting(store, second.meeting.id, { format: "vtt", transcriptId })
    expect(historic.filename).toBe(`meeting-${second.meeting.id}-transcript-${transcriptId}.vtt`)
    expect(parseVtt(historic.content)[0]?.text).toBe("Ship the example plan.")
    await expect(exportMeeting(store, second.meeting.id, { accountId: 2, format: "vtt" })).rejects.toMatchObject({
      code: "not_found",
    })
    await expect(exportMeeting(store, second.meeting.id, { format: "vtt", transcriptId: 999 })).rejects.toMatchObject({
      code: "not_found",
    })
    await expect(
      exportMeeting(store, second.meeting.id, { format: "markdown", transcriptId: 0 }),
    ).rejects.toMatchObject({ code: "validation_error" })
  })

  it("requires selection for multiple active VTT sources and preserves empty summaries", async () => {
    const store = memoryMeetingStore()
    const input = sampleMeeting()
    input.transcripts.push({ ...structuredClone(input.transcripts[0]), source: "file", contentHash: "other-example" })
    present(input.summaries?.[0]).content = ""
    const saved = await store.saveMeeting(input)
    await expect(exportMeeting(store, saved.meeting.id, { format: "vtt" })).rejects.toThrow(/choose a transcript/)
    const markdown = await exportMeeting(store, saved.meeting.id, { format: "markdown" })
    expect(markdown.content).not.toContain("Example overview")
    const empty: MeetingSave = sampleMeeting()
    empty.meeting.externalId = "empty-example"
    empty.transcripts = []
    empty.summaries = []
    const without = await store.saveMeeting(empty)
    await expect(exportMeeting(store, without.meeting.id, { format: "vtt" })).rejects.toMatchObject({
      code: "not_found",
    })
    expect((await exportMeeting(store, without.meeting.id, { format: "markdown" })).content).toContain(
      "Example planning",
    )
    await expect(exportMeeting(store, without.meeting.id, { format: "bad" as "vtt" })).rejects.toMatchObject({
      code: "validation_error",
    })
  })

  it("renders structured summaries only when full content is absent and escapes Markdown text", async () => {
    const store = memoryMeetingStore()
    const input = sampleMeeting()
    input.meeting.title = "[Example](https://example.com)"
    input.meeting.description = null
    input.transcripts[0].rows[0].speakerName = null
    present(input.summaries?.[0]).content = null
    present(input.summaries?.[0]).title = null
    const saved = await store.saveMeeting(input)
    const result = await exportMeeting(store, saved.meeting.id, { format: "markdown" })
    expect(result.content).toContain("\\[Example\\]\\(https://example\\.com\\)")
    expect(result.content).toContain("Example overview")
    expect(result.content).toContain("### Plan")
    expect(result.content).toContain("- Example next step")
    expect(result.content).not.toContain("## Description")
    const detailed = await store.meeting(saved.meeting.id)
    if (!detailed) throw new Error("missing fixture")
    detailed.meeting.title = null
    present(detailed.summaries[0]).overview = null
    present(detailed.summaries[0]).sections = []
    present(detailed.summaries[0]).nextSteps = []
    present(detailed.transcripts[0]).transcript.supersededAt = 5000
    present(detailed.transcripts[0]).transcript.source = "file"
    store.meeting = async () => detailed
    expect(
      (
        await exportMeeting(store, saved.meeting.id, {
          format: "markdown",
          transcriptId: present(detailed.transcripts[0]).transcript.id,
        })
      ).content,
    ).toContain("Version: superseded")
    expect((await exportMeeting(store, saved.meeting.id, { format: "markdown" })).content).toContain("Untitled meeting")
  })
})

describe("WebVTT export", () => {
  it("keeps relative times beyond a day and encodes cue markup safely", () => {
    expect(
      serializeVtt([
        { startMs: 93600123, endMs: 93602123, speaker: "Alice & Bob", text: "<example>\nsecond line" },
        { startMs: 93603000, endMs: 93604000, speaker: null, text: "plain" },
      ]),
    ).toBe(
      "WEBVTT\n\n1\n26:00:00.123 --> 26:00:02.123\nAlice &amp; Bob: &lt;example&gt;\nsecond line\n\n2\n26:00:03.000 --> 26:00:04.000\nplain\n\n",
    )
    expect(serializeVtt([])).toBe("WEBVTT\n\n")
  })
  it("refuses invalid timing or cue paragraphs instead of silently changing content", () => {
    const base = { startMs: 0, endMs: 1000, speaker: null, text: "example" }
    for (const change of [
      { startMs: -1 },
      { startMs: 0.5 },
      { endMs: Number.NaN },
      { endMs: Number.MAX_SAFE_INTEGER + 1 },
      { endMs: 0 },
      { text: "first\n\nsecond" },
      { text: "first\rsecond" },
      { text: String.fromCharCode(0) },
      { speaker: "Alice\nExample" },
    ])
      expect(() => serializeVtt([{ ...base, ...change }])).toThrow()
    expect(() => serializeVtt([{ ...base, startMs: 2000, endMs: 3000 }, base])).toThrow(/nondecreasing/)
    expect(() => serializeVtt([{ ...base, text: `${String.fromCharCode(27)}[31mexample` }])).toThrow()
  })
})

it("shares summary/history/export between CLI and MCP and writes files only through the host", async () => {
  const { store, second } = await corrected()
  const values: unknown[] = []
  const files: [string, string][] = []
  let writer: ((path: string, content: string) => Promise<void>) | undefined = async (path, content) => {
    files.push([path, content])
  }
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride().configureOutput({ writeErr() {}, writeOut() {} })
    addMeetingCommands(program, {
      store,
      accountId: 1,
      write: (value) => {
        values.push(value)
      },
      writeFile: writer,
    })
    await program.parseAsync(args, { from: "user" })
  }
  const id = String(second.meeting.id)
  await run("meetings", "summary", id)
  expect(values.at(-1)).toEqual(
    (await callMeetingTool(store, "meeting_summary", { meeting: second.meeting.id, account_id: 1 })).structuredContent,
  )
  await run("meetings", "transcript", id, "--history")
  expect(values.at(-1)).toEqual(
    (await callMeetingTool(store, "meeting_transcript", { meeting: second.meeting.id, history: true }))
      .structuredContent,
  )
  await run("meetings", "export", id, "--format", "vtt")
  expect(values.at(-1)).toEqual(
    (await callMeetingTool(store, "meeting_export", { meeting: second.meeting.id, format: "vtt" })).structuredContent,
  )
  await run("meetings", "export", id, "--output", "example.md")
  expect(files[0]?.[1]).toContain("Corrected example text")
  expect(values.at(-1)).toEqual({ meetingId: second.meeting.id, format: "markdown", output: "example.md" })
  writer = async () => {
    throw new Error("write failed")
  }
  const before = values.length
  await expect(run("meetings", "export", id, "--output", "example.md")).rejects.toThrow("write failed")
  expect(values).toHaveLength(before)
  writer = undefined
  await expect(run("meetings", "export", id, "--output", "example.md")).rejects.toMatchObject({
    code: "configuration_error",
  })
  await expect(run("meetings", "export", id, "--output", " ")).rejects.toMatchObject({ code: "validation_error" })
})

it("validates MCP export/history/account filters and passes supported search filters", async () => {
  const { store, second } = await corrected()
  for (const [name, input] of [
    ["meeting_export", { meeting: second.meeting.id, format: "bad" }],
    ["meeting_export", { meeting: second.meeting.id, format: "vtt", transcript_id: -1 }],
    ["meeting_transcript", { meeting: second.meeting.id, history: "yes" }],
    ["meeting_summary", { meeting: second.meeting.id, account_id: 2 }],
  ] as const)
    expect((await callMeetingTool(store, name, input)).isError).toBe(true)
  let captured: unknown
  store.search = async (_query, filter) => {
    captured = filter
    return []
  }
  const program = new Command().exitOverride()
  addMeetingCommands(program, { store, accountId: 1, write() {} })
  await program.parseAsync(
    [
      "meetings",
      "search",
      "example",
      "--since",
      "1970-01-01",
      "--until",
      "1970-01-02",
      "--event-id",
      "2",
      "--series-id",
      "3",
    ],
    { from: "user" },
  )
  expect(captured).toEqual({ accountId: 1, since: 0, until: 86400000, eventId: 2, meetingSeriesId: 3 })
  await callMeetingTool(store, "meetings_search", { query: "example", account_id: 1, event_id: 2, series_id: 3 })
  expect(captured).toMatchObject({ accountId: 1, eventId: 2, meetingSeriesId: 3 })
})
