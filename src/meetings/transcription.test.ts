import { CliError } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import { memoryMeetingStore } from "./testing/memory.js"
import { sampleMeeting } from "./testing/samples.js"
import {
  type MeetingMediaDescriptor,
  type MeetingRecognitionSegment,
  type MeetingTranscriptionOptions,
  transcribeMeeting,
} from "./transcription.js"

const target = { accountId: 1, externalId: "example-occurrence", now: 5000 }
const media = (): MeetingMediaDescriptor => ({
  id: "example.wav",
  contentHash: "a".repeat(64),
  size: 100,
  durationMs: 60_000,
  format: "wav",
  sampleRate: 16_000,
  channels: 1,
  recognition: { engine: "example-engine", model: "example-model", version: "example-version" },
})
const setup = async (
  segments: MeetingRecognitionSegment[] = [{ startMs: 0, endMs: 1000, text: " Example speech " }],
) => {
  const native = memoryMeetingStore()
  await native.saveMeeting(sampleMeeting())
  const appendTranscriptsWithReceipt = vi.fn(async (input: Parameters<typeof native.appendTranscripts>[0]) => ({
    meeting: await native.appendTranscripts(input),
    created: false,
    insertedTranscripts: 1,
    replayedTranscripts: 0,
    supersededTranscripts: 0,
  }))
  const source = {
    describe: vi.fn(async () => media()),
    segments: vi.fn(async function* () {
      yield* segments
    }),
  }
  return { source, store: { appendTranscriptsWithReceipt }, native }
}

describe("local meeting transcription", () => {
  it("previews without recognition or writes; explicit apply appends provenance separately", async () => {
    const fixture = await setup([
      { startMs: 0, endMs: 1000, text: " " },
      { startMs: 1000, endMs: 2000, text: "Example speech" },
    ])
    const preview = await transcribeMeeting(fixture.source, fixture.store, target)
    expect(preview).toMatchObject({ applied: false, segments: 0, media: media() })
    await transcribeMeeting(fixture.source, fixture.store, target, { apply: true, dryRun: true })
    expect(fixture.source.segments).not.toHaveBeenCalled()
    expect(fixture.store.appendTranscriptsWithReceipt).not.toHaveBeenCalled()
    const result = await transcribeMeeting(fixture.source, fixture.store, target, { apply: true })
    expect(result).toMatchObject({ applied: true, segments: 1, append: { created: false, insertedTranscripts: 1 } })
    expect(fixture.store.appendTranscriptsWithReceipt).toHaveBeenCalledTimes(1)
    const input = fixture.store.appendTranscriptsWithReceipt.mock.calls[0]?.[0]
    expect(input).not.toHaveProperty("create")
    expect(input?.transcripts[0]).toMatchObject({
      source: "local/example-engine/example-model",
      format: "local-transcription",
      metadata: {
        mediaSha256: "a".repeat(64),
        engine: "example-engine",
        model: "example-model",
        modelVersion: "example-version",
      },
      rows: [{ position: 0, startMs: 1000, endMs: 2000, text: "Example speech", speakerName: null }],
    })
    const beforeHash = input?.transcripts[0]?.contentHash
    await transcribeMeeting(fixture.source, fixture.store, target, { apply: true })
    expect(fixture.store.appendTranscriptsWithReceipt.mock.calls[1]?.[0].transcripts[0]?.contentHash).toBe(beforeHash)
    const stored = await fixture.native.meetings()
    expect((await fixture.native.meeting(stored[0]?.id ?? 0))?.transcripts[0]?.transcript.source).toBe("api")
  })

  it("captures consent before asynchronous description and supports unversioned engines", async () => {
    const fixture = await setup()
    const options: MeetingTranscriptionOptions = {}
    fixture.source.describe.mockImplementation(async () => {
      options.apply = true
      const value = media()
      delete value.recognition.version
      return value
    })
    expect((await transcribeMeeting(fixture.source, fixture.store, target, options)).applied).toBe(false)
    const result = await transcribeMeeting(fixture.source, fixture.store, target, { apply: true })
    expect(result.append?.meeting.transcripts.at(-1)?.transcript.metadata?.modelVersion).toBe(null)
  })

  it.each([
    { accountId: 0 },
    { accountId: 1.5 },
    { externalId: "" },
    { externalId: "\0" },
    { externalId: "x".repeat(1001) },
    { now: -1 },
    { now: NaN },
  ])("rejects bad targets before any read %#", async (change) => {
    const fixture = await setup()
    await expect(transcribeMeeting(fixture.source, fixture.store, { ...target, ...change })).rejects.toThrow()
    expect(fixture.source.describe).not.toHaveBeenCalled()
  })

  it.each<MeetingTranscriptionOptions>([
    { maxBytes: 0 },
    { maxDurationMs: 86_400_001 },
    { maxSegments: 0 },
    { maxTextBytes: 1.5 },
  ])("rejects bad limits before reads %#", async (options) => {
    const fixture = await setup()
    await expect(transcribeMeeting(fixture.source, fixture.store, target, options)).rejects.toThrow()
    expect(fixture.source.describe).not.toHaveBeenCalled()
  })

  it.each<Partial<MeetingMediaDescriptor>>([
    { contentHash: "wrong" },
    { size: 0 },
    { durationMs: 0 },
    { sampleRate: 0 },
    { channels: 33 },
    { recognition: { engine: "", model: "example" } },
    { format: "\n" },
    { recognition: { engine: "example", model: "example", timing: "invalid" as never } },
  ])("refuses invalid media descriptors %#", async (change) => {
    const fixture = await setup()
    fixture.source.describe.mockResolvedValue({ ...media(), ...change })
    await expect(transcribeMeeting(fixture.source, fixture.store, target, { apply: true })).rejects.toThrow()
    expect(fixture.source.segments).not.toHaveBeenCalled()
  })

  it.each(
    [
      [{ startMs: -1, endMs: 1, text: "Example" }],
      [{ startMs: 0, endMs: 0, text: "Example" }],
      [{ startMs: 0, endMs: 60_001, text: "Example" }],
      [{ startMs: 0.5, endMs: 1, text: "Example" }],
      [{ startMs: 0, endMs: 1.5, text: "Example" }],
      [{ startMs: 0, endMs: 1, text: 1 as never }],
      [{ startMs: 0, endMs: 1, text: "\0" }],
      [
        { startMs: 0, endMs: 1000, text: "Example" },
        { startMs: 900, endMs: 1500, text: "Example" },
      ],
      [],
    ].map((segments) => ({ segments })),
  )("never appends partial or invalid recognition %#", async ({ segments }) => {
    const fixture = await setup(segments)
    await expect(transcribeMeeting(fixture.source, fixture.store, target, { apply: true })).rejects.toThrow()
    expect(fixture.store.appendTranscriptsWithReceipt).not.toHaveBeenCalled()
  })

  it("enforces segment and UTF-8 budgets before append", async () => {
    const fixture = await setup([
      { startMs: 0, endMs: 1, text: "é" },
      { startMs: 1, endMs: 2, text: "Example" },
    ])
    await expect(
      transcribeMeeting(fixture.source, fixture.store, target, { apply: true, maxSegments: 1 }),
    ).rejects.toThrow()
    await expect(
      transcribeMeeting(fixture.source, fixture.store, target, { apply: true, maxTextBytes: 1 }),
    ).rejects.toThrow()
    expect(fixture.store.appendTranscriptsWithReceipt).not.toHaveBeenCalled()
  })

  it("refuses foreign or invalid commit acknowledgements without retry", async () => {
    const fixture = await setup()
    const original = await fixture.native.saveMeeting(sampleMeeting())
    for (const change of [
      { created: true },
      { insertedTranscripts: -1 },
      { replayedTranscripts: 2 },
      { meeting: { ...original, meeting: { ...original.meeting, accountId: 2 } } },
      { meeting: { ...original, meeting: { ...original.meeting, externalId: "foreign" } } },
      { meeting: { ...original, meeting: { ...original.meeting, deletedAt: 6000 } } },
      { meeting: { ...original, meeting: { ...original.meeting, id: 0 } } },
    ]) {
      fixture.store.appendTranscriptsWithReceipt.mockResolvedValueOnce({
        meeting: original,
        created: false,
        insertedTranscripts: 1,
        replayedTranscripts: 0,
        supersededTranscripts: 0,
        ...change,
      })
      await expect(transcribeMeeting(fixture.source, fixture.store, target, { apply: true })).rejects.toMatchObject({
        code: "outcome_unknown",
      })
    }
    expect(fixture.store.appendTranscriptsWithReceipt).toHaveBeenCalledTimes(7)
    fixture.source.describe.mockResolvedValue({
      ...media(),
      recognition: { engine: "example", model: "example", timing: "fixed-windows" },
    })
    await transcribeMeeting(fixture.source, fixture.store, target, { apply: true })
    expect(fixture.store.appendTranscriptsWithReceipt.mock.calls.at(-1)?.[0].transcripts[0]?.metadata?.timing).toBe(
      "fixed-windows",
    )
  })

  it("classifies missing and throwing acknowledgements after a possible commit", async () => {
    const fixture = await setup()
    const malformed = [
      undefined,
      null,
      {},
      { meeting: null },
      { meeting: { meeting: null } },
      {
        get meeting() {
          throw new Error("broken acknowledgement")
        },
      },
    ]
    for (const value of malformed) {
      fixture.store.appendTranscriptsWithReceipt.mockResolvedValueOnce(value as never)
      await expect(transcribeMeeting(fixture.source, fixture.store, target, { apply: true })).rejects.toMatchObject({
        code: "outcome_unknown",
      })
    }
    expect(fixture.store.appendTranscriptsWithReceipt).toHaveBeenCalledTimes(malformed.length)
  })

  it("keeps cancellation and backend errors from committing partial rows", async () => {
    const fixture = await setup()
    const controller = new AbortController()
    controller.abort(new CliError("timeout", "deadline"))
    await expect(
      transcribeMeeting(fixture.source, fixture.store, target, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "timeout" })
    expect(fixture.source.describe).not.toHaveBeenCalled()
    const second = new AbortController()
    fixture.source.describe.mockImplementation(async () => {
      const error = new Error("deadline")
      error.name = "TimeoutError"
      second.abort(error)
      return media()
    })
    await expect(
      transcribeMeeting(fixture.source, fixture.store, target, { signal: second.signal }),
    ).rejects.toMatchObject({ code: "timeout" })
    fixture.source.describe.mockResolvedValue(media())
    const third = new AbortController()
    fixture.source.segments.mockImplementation(async function* () {
      yield { startMs: 0, endMs: 1, text: "Example" }
      third.abort()
      yield { startMs: 1, endMs: 2, text: "Example" }
    })
    await expect(
      transcribeMeeting(fixture.source, fixture.store, target, { apply: true, signal: third.signal }),
    ).rejects.toMatchObject({ code: "cancelled" })
    fixture.source.segments.mockImplementation(async function* () {
      yield { startMs: 0, endMs: 1, text: "Example" }
      throw new Error("engine failure")
    })
    await expect(transcribeMeeting(fixture.source, fixture.store, target, { apply: true })).rejects.toThrow(
      "engine failure",
    )
    expect(fixture.store.appendTranscriptsWithReceipt).not.toHaveBeenCalled()
    fixture.source.segments.mockImplementation(async function* () {
      yield { startMs: 0, endMs: 1, text: "Example" }
    })
    const error = new CliError("configuration_error", "unknown append outcome")
    fixture.store.appendTranscriptsWithReceipt.mockRejectedValue(error)
    await expect(transcribeMeeting(fixture.source, fixture.store, target, { apply: true })).rejects.toBe(error)
    expect(fixture.store.appendTranscriptsWithReceipt).toHaveBeenCalledTimes(1)
  })

  it("**keeps who spoke** and lets two speakers talk over each other, never one speaker over themself", async () => {
    const dialogue = await setup([
      { startMs: 0, endMs: 3000, text: "Hello", speaker: "manager" },
      { startMs: 2000, endMs: 4000, text: "Hi there", speaker: "client" },
      { startMs: 3500, endMs: 5000, text: "So", speaker: "manager " },
      { startMs: 5000, endMs: 6000, text: "Noted", speaker: null },
    ])
    await transcribeMeeting(dialogue.source, dialogue.store, target, { apply: true })
    expect(
      dialogue.store.appendTranscriptsWithReceipt.mock.calls[0]?.[0].transcripts[0]?.rows.map(
        ({ speakerName, startMs }) => [speakerName, startMs],
      ),
    ).toEqual([
      ["manager", 0],
      ["client", 2000],
      ["manager", 3500],
      [null, 5000],
    ])

    for (const segments of [
      [
        { startMs: 0, endMs: 3000, text: "Hello", speaker: "manager" },
        { startMs: 2000, endMs: 4000, text: "again", speaker: " manager" },
      ],
      [
        { startMs: 0, endMs: 3000, text: "Hello" },
        { startMs: 2000, endMs: 4000, text: "again" },
      ],
      [
        { startMs: 2000, endMs: 3000, text: "Hello", speaker: "manager" },
        { startMs: 1000, endMs: 4000, text: "earlier", speaker: "client" },
      ],
    ]) {
      const fixture = await setup(segments)
      await expect(transcribeMeeting(fixture.source, fixture.store, target, { apply: true })).rejects.toMatchObject({
        code: "invalid_response",
      })
    }
  })

  it("names OpenAI as the source of what it recognized", async () => {
    const fixture = await setup()
    fixture.source.describe.mockResolvedValue({
      ...media(),
      recognition: { engine: "openai", model: "gpt-transcribe" },
    })
    await transcribeMeeting(fixture.source, fixture.store, target, { apply: true })
    expect(fixture.store.appendTranscriptsWithReceipt.mock.calls[0]?.[0].transcripts[0]).toMatchObject({
      source: "openai/gpt-transcribe",
      format: "openai-transcription",
    })
  })
})
