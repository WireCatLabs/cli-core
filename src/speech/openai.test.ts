import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { decodeChannels } from "./decode.js"
import { piecesOf, transcribeOpenAI } from "./openai.js"
import { SAMPLE_RATE, type SpeechCutter } from "./recognize.js"

const fixture = (name: string) => new URL(`../testing/fixtures/${name}`, import.meta.url)
const silence = (seconds: number) => ({ samples: new Float32Array(SAMPLE_RATE * seconds), rate: SAMPLE_RATE })
const answering = (...texts: string[]) => {
  let next = 0
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: texts[next++] ?? "" })))
}
const formOf = (call: [string, RequestInit] | undefined) => call?.[1].body as FormData
const cutting = (spans: { start: number; end: number }[]) => (): SpeechCutter => ({ cut: () => spans, free: () => {} })
const instant = { sleep: async () => {}, random: () => 0 }

describe("transcribing with OpenAI", () => {
  it("**sends a short recording whole**, as WAV with the model, languages, keywords and prompt", async () => {
    const fetch = answering(" Привет ")

    const heard = await transcribeOpenAI(silence(2), {
      apiKey: "sk-synthetic",
      languages: ["ru", "en"],
      keywords: ["Билайн"],
      prompt: "a sales call",
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

  it("**sends each piece the detector cut**, with its own time, and joins speech cut without a pause", async () => {
    const fetch = answering("first", "", "third")
    const spans = [
      { start: 1, end: 3 },
      { start: 3, end: 4 },
      { start: 10, end: 12 },
      { start: 20, end: 25 },
    ]

    const heard = await transcribeOpenAI(silence(30), {
      apiKey: "sk-synthetic",
      pieceSeconds: 2,
      cutter: cutting(spans),
      fetch,
    })

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(heard).toEqual([
      { start: 1, end: 4, text: "first" },
      { start: 20, end: 25, text: "third" },
    ])
    const padded = Math.ceil(4.2 * SAMPLE_RATE) - Math.floor(0.8 * SAMPLE_RATE)
    expect((formOf(fetch.mock.calls[0]).get("file") as File).size).toBe(44 + 2 * padded)
  })

  it("groups neighbouring speech up to the piece length", () => {
    expect(
      piecesOf(
        [
          { start: 0, end: 4 },
          { start: 5, end: 9 },
          { start: 11, end: 14 },
        ],
        10,
      ),
    ).toEqual([
      { start: 0, end: 9 },
      { start: 11, end: 14 },
    ])
  })

  it("**cuts real speech at its pauses** with the voice detector, and cuts the same way twice", async () => {
    const [channel] = await decodeChannels(new Uint8Array(readFileSync(fixture("quiet-middle.ogg"))))
    const options = { apiKey: "sk-synthetic", pieceSeconds: 5, vadModel: fileURLToPath(fixture("silero_vad.onnx")) }
    const texts = Array.from({ length: 20 }, (_, index) => `piece ${index}`)
    const fetch = answering(...texts)

    const first = await transcribeOpenAI(channel as never, { ...options, fetch })
    const again = await transcribeOpenAI(channel as never, { ...options, fetch: answering(...texts) })

    expect(first.length).toBeGreaterThan(2)
    expect(first.every(({ start, end }, index) => start < end && start >= (first[index - 1]?.end ?? 0))).toBe(true)
    expect(first.at(-1)?.end).toBeLessThanOrEqual(20.4)
    expect(fetch).toHaveBeenCalledTimes(first.length)
    expect(again).toEqual(first)
  })

  it("**says the key was refused**, never what the key is", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "sk-synthetic" } }), { status: 401 }),
    )

    const failure = await transcribeOpenAI(silence(1), { apiKey: "sk-synthetic", fetch }).catch((error) => error)

    expect(failure).toMatchObject({ code: "authentication_error", details: { reason: "auth.failed" } })
    expect(failure.message).toContain("invalid_api_key")
    expect(failure.message).not.toContain("sk-synthetic")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("**waits as long as OpenAI asks after a 429**, then tries again", async () => {
    const sleep = vi.fn(async () => {})
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "after the wait" })))

    const heard = await transcribeOpenAI(silence(1), { apiKey: "sk-synthetic", fetch, sleep })

    expect(heard[0]?.text).toBe("after the wait")
    expect(sleep).toHaveBeenCalledWith(2000, undefined)
  })

  it("gives up on a server that keeps failing, and refuses without a key", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 503 }))

    await expect(transcribeOpenAI(silence(1), { apiKey: "sk-synthetic", fetch, ...instant })).rejects.toMatchObject({
      code: "provider_unavailable",
    })
    expect(fetch).toHaveBeenCalledTimes(5)
    await expect(transcribeOpenAI(silence(1), { apiKey: "", fetch })).rejects.toMatchObject({
      details: { reason: "transcription.no-key" },
    })
  })
})
