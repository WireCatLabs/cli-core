import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { transcribeMeeting } from "../meetings/index.js"
import { memoryMeetingStore, sampleMeeting } from "../meetings/testing/index.js"
import { decodeChannels, type Pcm } from "./decode.js"
import { piecesOf, transcribeOpenAI } from "./openai.js"
import { openSpeechCutter, SAMPLE_RATE, type SpeechCutter, toModelRate } from "./recognize.js"

const fixture = (name: string) => new URL(`../testing/fixtures/${name}`, import.meta.url)
const vadModel = fileURLToPath(fixture("silero_vad.onnx"))
const silence = (seconds: number) => ({ samples: new Float32Array(SAMPLE_RATE * seconds), rate: SAMPLE_RATE })
const answering = (...texts: string[]) => {
  let next = 0
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: texts[next++] ?? "" })))
}
const failing = (status: number, error: object) =>
  vi.fn(async () => new Response(JSON.stringify({ error: { message: "sk-synthetic was used", ...error } }), { status }))
const formOf = (call: [string, RequestInit] | undefined) => call?.[1].body as FormData
const cutting = (spans: { start: number; end: number }[]) => (): SpeechCutter => ({ cut: () => spans, free: () => {} })
const instant = { sleep: async () => {}, random: () => 0 }
const channelsOf = async (name: string) =>
  (await decodeChannels(new Uint8Array(readFileSync(fixture(name))))).channels as [Pcm, ...Pcm[]]

describe("transcribing with OpenAI", () => {
  it("**sends a short recording whole when bundled**, as WAV with the model, languages, keywords and prompt", async () => {
    const fetch = answering(" Привет ")

    const heard = await transcribeOpenAI(silence(2), {
      apiKey: "sk-synthetic",
      languages: ["ru", "en"],
      keywords: ["Билайн"],
      prompt: "a sales call",
      bundle: true,
      fetch,
    })

    expect(heard).toEqual([{ start: 0, end: 2, text: "Привет" }])
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions")
    expect(init?.headers).toEqual({ authorization: "Bearer sk-synthetic" })
    const form = formOf(fetch.mock.calls[0])
    expect(form.get("model")).toBe("gpt-transcribe")
    expect(form.getAll("languages[]")).toEqual(["ru", "en"])
    expect(form.has("language")).toBe(false)
    expect(form.getAll("keywords[]")).toEqual(["Билайн"])
    expect(form.get("prompt")).toBe("a sales call")
    const file = form.get("file") as File
    expect([file.name, file.type, file.size]).toEqual(["audio.wav", "audio/wav", 44 + 2 * 2 * SAMPLE_RATE])
  })

  it("**sends each stretch of speech alone** with its time, joining only a cut made without a pause", async () => {
    const fetch = answering("first", "", "third")
    const spans = [
      { start: 1, end: 3 },
      { start: 3.1, end: 4 },
      { start: 4.5, end: 6 },
      { start: 20, end: 31 },
    ]

    const heard = await transcribeOpenAI(silence(30), { apiKey: "sk-synthetic", cutter: cutting(spans), fetch })

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(heard).toEqual([
      { start: 1, end: 4, text: "first" },
      { start: 20, end: 30, text: "third" },
    ])
    const padded = Math.ceil(4.2 * SAMPLE_RATE) - Math.floor(0.8 * SAMPLE_RATE)
    expect((formOf(fetch.mock.calls[0]).get("file") as File).size).toBe(44 + 2 * padded)
  })

  it("joins neighbours across pauses only up to a limit a caller asks for", () => {
    const spans = [
      { start: 0, end: 4 },
      { start: 5, end: 9 },
      { start: 11, end: 14 },
    ]

    expect(piecesOf(spans)).toEqual(spans)
    expect(piecesOf(spans, 10)).toEqual([
      { start: 0, end: 9 },
      { start: 11, end: 14 },
    ])
  })

  it("**keeps continuous speech whole where the detector cut it at 20 seconds**, never mid-word", async () => {
    const [channel] = await channelsOf("quiet-middle.ogg")
    const cutter = openSpeechCutter(vadModel)
    try {
      const pcm = toModelRate(channel.samples, channel.rate)
      const speech = pcm.subarray(SAMPLE_RATE / 2)
      const stretches = cutter
        .cut(pcm)
        .map(({ start, end }) => speech.subarray(Math.floor(start * SAMPLE_RATE), Math.floor(end * SAMPLE_RATE)))
      const length = stretches.reduce((sum, stretch) => sum + stretch.length, 0)
      const continuous = new Float32Array(SAMPLE_RATE / 2 + length * 3)
      let at = SAMPLE_RATE / 2
      for (let round = 0; round < 3; round++)
        for (const stretch of stretches) {
          continuous.set(stretch, at)
          at += stretch.length
        }

      const cuts = cutter.cut(continuous)
      const forced = cuts.slice(1).filter((cut, index) => cut.start - (cuts[index]?.end ?? 0) < 0.2)

      const pieces = piecesOf(cuts)

      expect(forced.length).toBeGreaterThan(0)
      expect(forced.every(({ start }) => pieces.some((piece) => piece.start < start && start < piece.end))).toBe(true)
      expect(pieces.every((piece, index) => (pieces[index + 1]?.start ?? Infinity) - piece.end >= 0.2)).toBe(true)
    } finally {
      cutter.free()
    }
  })

  it("**hears a two-speaker call as a dialogue in the order people spoke**", async () => {
    const [manager, client] = await channelsOf("dialogue.mp3")
    const durationMs = Math.floor((manager.samples.length / manager.rate) * 1000)
    const channel = async (audio: Pcm, speaker: string) => {
      let line = 0
      const fetch = vi.fn(async () => new Response(JSON.stringify({ text: `${speaker} ${++line}` })))
      return (await transcribeOpenAI(audio, { apiKey: "sk-synthetic", vadModel, fetch })).map((piece) => ({
        ...piece,
        speaker,
      }))
    }
    const dialogue = [...(await channel(manager, "manager")), ...(await channel(client as Pcm, "client"))].sort(
      (a, b) => a.start - b.start,
    )
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
      describe: async () => ({
        id: "dialogue.mp3",
        contentHash: "c".repeat(64),
        size: 1,
        durationMs,
        format: "mp3",
        sampleRate: manager.rate,
        channels: 2,
        recognition: { engine: "openai", model: "gpt-transcribe" },
      }),
      segments: async function* () {
        for (const { start, end, text, speaker } of dialogue)
          yield { startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), text, speaker }
      },
    }

    await transcribeMeeting(
      source,
      { appendTranscriptsWithReceipt },
      { accountId: 1, externalId: "example-occurrence", now: 5000 },
      { apply: true },
    )

    const rows = appendTranscriptsWithReceipt.mock.calls[0]?.[0].transcripts[0]?.rows ?? []
    expect(rows.map(({ speakerName }) => speakerName)).toEqual(["manager", "client", "manager"])
    expect(rows.map(({ startMs }) => Math.round(startMs / 1000))).toEqual([0, 5, 11])
  })

  it("**says the key was refused** on 401, never what the key is", async () => {
    const fetch = failing(401, { code: "invalid_api_key" })

    const failure = await transcribeOpenAI(silence(1), { apiKey: "sk-synthetic", bundle: true, fetch }).catch(
      (error) => error,
    )

    expect(failure).toMatchObject({ code: "authentication_error", details: { reason: "auth.failed" } })
    expect(failure.message).toContain("invalid_api_key")
    expect(failure.message).not.toContain("sk-synthetic")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("**does not blame the key for a 403**, which OpenAI also answers for an unsupported country", async () => {
    const failure = await transcribeOpenAI(silence(1), {
      apiKey: "sk-synthetic",
      bundle: true,
      fetch: failing(403, { code: "unsupported_country_region_territory" }),
    }).catch((error) => error)

    expect(failure).toMatchObject({ code: "permission_error", details: { reason: "access.denied" } })
    expect(failure.message).toMatch(/country or region/)
    expect(failure.message).not.toMatch(/key \(/)
  })

  it.each([
    ["insufficient_quota", { type: "insufficient_quota" }],
    ["credit_balance_exhausted", { code: "credit_balance_exhausted" }],
    ["organization_spend_limit_exceeded", { code: "organization_spend_limit_exceeded" }],
  ])("**never waits out a 429 that says %s**: the money or limit is used up", async (_, error) => {
    const fetch = failing(429, error)

    await expect(
      transcribeOpenAI(silence(1), { apiKey: "sk-synthetic", bundle: true, fetch, ...instant }),
    ).rejects.toMatchObject({ code: "permission_error", details: { reason: "transcription.quota-exhausted" } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("**waits as long as OpenAI asks after a 429**, then tries again", async () => {
    const sleep = vi.fn(async () => {})
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "after the wait" })))

    const heard = await transcribeOpenAI(silence(1), { apiKey: "sk-synthetic", bundle: true, fetch, sleep })

    expect(heard[0]?.text).toBe("after the wait")
    expect(sleep).toHaveBeenCalledWith(2000, undefined)
  })

  it("gives up on a server that keeps failing, and refuses without a key or with a keyword OpenAI would refuse", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 503 }))
    const options = { apiKey: "sk-synthetic", bundle: true, fetch, ...instant }

    await expect(transcribeOpenAI(silence(1), options)).rejects.toMatchObject({ code: "provider_unavailable" })
    expect(fetch).toHaveBeenCalledTimes(5)
    await expect(transcribeOpenAI(silence(1), { ...options, apiKey: "" })).rejects.toMatchObject({
      details: { reason: "transcription.no-key" },
    })
    for (const keywords of [["<b>"], ["two\nlines"], [" "]])
      await expect(transcribeOpenAI(silence(1), { ...options, keywords })).rejects.toMatchObject({
        code: "validation_error",
      })
    expect(fetch).toHaveBeenCalledTimes(5)
  })

  it("is cancelled, not a bad answer, when the command stops while the answer is read", async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async () => {
      controller.abort()
      return new Response(new ReadableStream({ start: (stream) => stream.error(new Error("aborted")) }))
    })

    await expect(
      transcribeOpenAI(silence(1), { apiKey: "sk-synthetic", bundle: true, fetch, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" })
  })
})
