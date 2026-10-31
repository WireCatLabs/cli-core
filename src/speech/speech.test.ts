import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CliError } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import {
  DEFAULT_ORDER,
  install,
  isInstalled,
  modelPath,
  modelsDirectory,
  orderedModels,
  type SpeechModel,
  speechModel,
  VAD,
  vadPath,
} from "./index.js"
import { installFiles } from "./install.js"
import { decodeOgg, detector, loadSherpa, SAMPLE_RATE, toModelRate } from "./recognize.js"
import { type Choice, choose, hearLocally, hearOnline } from "./transcribe.js"

vi.mock("./recognize.js", async (original) => ({
  ...(await original<typeof import("./recognize.js")>()),
  openRecognizer: () => ({
    recognize: (pcm: Float32Array) => `heard ${pcm.length > SAMPLE_RATE ? "speech" : "nothing"}`,
    free: () => {},
  }),
}))

/** A sparse file at the pinned size — what `isInstalled` checks — without writing hundreds of MB. */
const sized = (path: string, bytes: number) => {
  writeFileSync(path, "")
  truncateSync(path, bytes)
}

const tone = new Uint8Array(readFileSync(new URL("../testing/fixtures/tone.ogg", import.meta.url)))
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

const tiny: SpeechModel = {
  id: "tiny",
  title: "tiny",
  languages: "none",
  featureDim: 64,
  files: [{ name: "model.onnx", url: "https://example.test/model.onnx", sha256: sha("weights"), bytes: 7 }],
  config: () => ({}),
}

const directoryWithVad = () => {
  const directory = mkdtempSync(join(tmpdir(), "models-"))
  sized(vadPath(directory), VAD.bytes)
  return directory
}

/** Every file of the model at its pinned size — what `isInstalled` checks. */
const installed = (model: SpeechModel) => {
  const directory = directoryWithVad()
  mkdirSync(join(directory, model.id))
  for (const file of model.files) sized(modelPath(directory, model)(file.name), file.bytes)
  return directory
}

const serving = (body: string) => async () => new Response(body)

describe("installing a speech model", () => {
  it("leaves an existing predictable temporary file untouched", async () => {
    const directory = directoryWithVad()
    mkdirSync(join(directory, tiny.id))
    const planted = `${modelPath(directory, tiny)("model.onnx")}.${process.pid}.part`
    writeFileSync(planted, "synthetic existing file")
    await install(tiny, directory, { fetch: serving("weights") })
    expect(readFileSync(planted, "utf8")).toBe("synthetic existing file")
    expect(readFileSync(modelPath(directory, tiny)("model.onnx"), "utf8")).toBe("weights")
  })

  it("**refuses a file whose sha256 is not the pinned one**, and leaves nothing behind", async () => {
    const directory = directoryWithVad()

    await expect(install(tiny, directory, { fetch: serving("Weights") })).rejects.toThrow(/not the file/)

    expect(isInstalled(tiny, directory)).toBe(false)
    expect(readdirSync(join(directory, "tiny"))).toEqual([])
  })

  it("stops reading a file that runs past its pinned size", async () => {
    const directory = directoryWithVad()

    await expect(install(tiny, directory, { fetch: serving("weights and more") })).rejects.toThrow(/larger than/)
  })

  it("installs a file that matches, and does not fetch it twice", async () => {
    const directory = directoryWithVad()
    let fetched = 0
    const fetch = async () => {
      fetched++
      return new Response("weights")
    }

    await install(tiny, directory, { fetch })
    await install(tiny, directory, { fetch })

    expect(isInstalled(tiny, directory)).toBe(true)
    expect(fetched).toBe(1)
  })
})

describe("audio for the model", () => {
  it("averages 48 kHz down to 16 kHz behind half a second of silence", () => {
    const pcm = toModelRate(new Float32Array([0.3, 0.3, 0.3, 0.6, 0.6, 0.6]), 48_000)

    expect(pcm.length).toBe(SAMPLE_RATE / 2 + 2)
    expect([...pcm.subarray(SAMPLE_RATE / 2)].map((sample) => sample.toFixed(2))).toEqual(["0.30", "0.60"])
  })
})

describe("the voice detector", () => {
  const fixture = (name: string) => new URL(`../testing/fixtures/${name}`, import.meta.url)
  interface Vad {
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    front(): { start: number; samples: Float32Array }
    pop(): void
    flush(): void
    free(): void
  }
  const sherpa = loadSherpa() as unknown as { createVad(config: object): Vad }

  /** The stretches, in seconds of the recording, that the detector hands to the model. */
  const heard = (pcm: Float32Array, config: ReturnType<typeof detector>) => {
    const vad = sherpa.createVad(config)
    const lead = SAMPLE_RATE / 2
    const stretches: [number, number][] = []
    const drain = () => {
      for (; !vad.isEmpty(); vad.pop()) {
        const { start, samples } = vad.front()
        stretches.push([(start - lead) / SAMPLE_RATE, (start + samples.length - lead) / SAMPLE_RATE])
      }
    }
    const window = config.sileroVad.windowSize
    for (let i = 0; i + window <= pcm.length; i += window) {
      vad.acceptWaveform(pcm.subarray(i, i + window))
      drain()
    }
    vad.flush()
    drain()
    vad.free()
    return stretches
  }
  const covers = (stretches: [number, number][], from: number, to: number) =>
    stretches.some(([start, end]) => start <= from && to <= end)

  it("**logs to stderr, never stdout**: --json output stays data when the engine grows its buffer", () => {
    const config = detector(fileURLToPath(fixture("silero_vad.onnx")))
    // The engine's own `require("fs")`, which an ESM import of node:fs is not under vitest.
    const writes = vi
      .spyOn(createRequire(import.meta.url)("node:fs") as typeof import("node:fs"), "writeSync")
      .mockImplementation((...[, , , length]: unknown[]) => Number(length))
    try {
      const vad = sherpa.createVad({ ...config, bufferSizeInSeconds: 0.05 })
      for (let i = 0; i < 20; i++)
        vad.acceptWaveform(new Float32Array(config.sileroVad.windowSize).fill(Math.sin(i) / 5))
      vad.free()
      const to = (fd: number) =>
        writes.mock.calls
          .filter(([one]) => one === fd)
          .map(([, data, offset, length]) =>
            Buffer.from(
              (data as unknown as Uint8Array).subarray(Number(offset ?? 0), Number(offset ?? 0) + Number(length)),
            ).toString(),
          )
      expect(to(1)).toEqual([])
      expect(to(2).join("")).toContain("Overflow")
    } finally {
      writes.mockRestore()
    }
  })

  it("**keeps a quietly spoken sentence between two loud ones**, which the default setting dropped", async () => {
    // A LibriVox reading (public domain) with "На славу вышел кисель. Всем по нраву пришёлся, всем угодил."
    // at 10.6–16.7 s made 25 dB quieter: fixtures/README.md.
    const [{ samples, rate }] = (await decodeOgg(new Uint8Array(readFileSync(fixture("quiet-middle.ogg"))))) as [
      { samples: Float32Array; rate: number },
    ]
    const pcm = toModelRate(samples, rate)
    const config = detector(fileURLToPath(fixture("silero_vad.onnx")))
    const kept = heard(pcm, config)
    const before = heard(pcm, { ...config, sileroVad: { ...config.sileroVad, threshold: 0.5 } })

    expect(covers(kept, 11, 12.8) && covers(kept, 13.8, 16.4)).toBe(true)
    expect(before.some(([start, end]) => end > 11 && start < 16.4)).toBe(false)
  })
})

describe("which model", () => {
  const messenger = (speechModels?: string[]) =>
    ({ app: { command: "chat", appName: "chat", envPrefix: "CHAT" }, provider: "chat", speechModels }) as Messenger
  const none = { configured: {}, shared: {} }

  it("**puts Parakeet first unless the CLI names its own order**", () => {
    expect(orderedModels().map((model) => model.id)).toEqual(DEFAULT_ORDER)
    expect(orderedModels(["gigaam-v3"]).map((model) => model.id)).toEqual(["gigaam-v3", "parakeet-v3", "gigaam-v3-ctc"])
    expect(choose(messenger(), none, {}).model.id).toBe("parakeet-v3")
    expect(choose(messenger(["gigaam-v3"]), none, {}).model.id).toBe("gigaam-v3")
  })

  it("takes the flag over the profile, and the profile over the CLI's order", () => {
    const profile = { configured: { speechModel: "gigaam-v3-ctc", transcribeWith: "messenger" }, shared: {} }

    expect(choose(messenger(), profile, {})).toMatchObject({ with: "messenger", model: { id: "gigaam-v3-ctc" } })
    expect(choose(messenger(), profile, { model: "gigaam-v3" })).toMatchObject({
      with: "local",
      model: { id: "gigaam-v3" },
    })
    expect(choose(messenger(), none, { local: true }).with).toBe("local")
    expect(() => choose(messenger(), none, { model: "whisper" })).toThrow(/no speech model "whisper"/)
  })

  it("**takes OpenAI only by name**, from the flag or the profile, with the key from OPENAI_API_KEY", () => {
    const keyed = { OPENAI_API_KEY: "sk-synthetic" }
    const keyring = memoryKeyring()
    const profile = { configured: { transcribeWith: "openai", transcribeModel: "gpt-transcribe-mini" }, shared: {} }

    expect(choose(messenger(), none, {}, keyed, keyring)).not.toHaveProperty("apiKey")
    expect(choose(messenger(), none, {}, keyed, keyring).with).toBe("auto")
    expect(choose(messenger(), none, { with: "openai" }, keyed, keyring)).toMatchObject({
      with: "openai",
      apiKey: "sk-synthetic",
      transcribeModel: "gpt-transcribe",
    })
    expect(choose(messenger(), profile, {}, keyed, keyring)).toMatchObject({
      with: "openai",
      transcribeModel: "gpt-transcribe-mini",
    })
    expect(choose(messenger(), profile, { local: true }, keyed, keyring).with).toBe("local")
    expect(choose(messenger(), profile, {}, {}, keyring).refusal?.message).toMatch(/no OpenAI key/)
    expect(choose(messenger(), profile, {}, { ...keyed, CHAT_READ_ONLY: "1" }, keyring).refusal?.message).toMatch(
      /read-only/,
    )
    const unknown = choose(messenger(), { configured: { transcribeWith: "whisper" }, shared: {} }, {}, keyed, keyring)
    expect(unknown.model.id).toBe("parakeet-v3")
    expect(unknown.refusal?.message).toMatch(/transcribeWith is one of/)
  })
})

describe("hearing a voice message", () => {
  const messenger = { app: { command: "chat" }, provider: "chat" } as Messenger
  const voice = {
    kind: "voice",
    mime: "audio/ogg",
    bytes: async function* () {
      yield tone
    },
  }
  const adapter = (transcribe?: MessengerAdapter["transcribe"]) =>
    ({ transcribe, download: async () => ({ files: [voice], skipped: [] }) }) as unknown as MessengerAdapter
  const choice = (overrides: Partial<Choice> = {}): Choice => ({
    with: "auto",
    model: speechModel("parakeet-v3"),
    directory: installed(speechModel("parakeet-v3")),
    ...overrides,
  })
  const refusing = async () => {
    throw new CliError("permission_error", "no Premium")
  }

  it("**asks the messenger first**, and says so", async () => {
    const heard = await hearOnline(
      messenger,
      adapter(async () => ({ text: "hi", pending: false })),
      "7",
      "5",
      choice(),
    )

    expect(heard).toEqual({ messageId: "5", text: "hi", pending: false, via: "chat" })
  })

  it("**falls back to the model on this machine when the messenger refuses the account**", async () => {
    const bytes = await hearOnline(messenger, adapter(refusing), "7", "5", choice())

    expect(bytes).toEqual(tone)
    expect(await hearLocally(bytes as Uint8Array, "5", choice())).toEqual({
      messageId: "5",
      text: "heard speech",
      pending: false,
      via: "local",
      model: "parakeet-v3",
    })
  })

  it("**fetches an audio file someone sent**, not only a voice note", async () => {
    const recording = { ...voice, kind: "audio", mime: "audio/mp4" }
    const sent = {
      transcribe: refusing,
      download: async () => ({ files: [{ kind: "photo", bytes: async function* () {} }, recording], skipped: [] }),
    } as unknown as MessengerAdapter

    expect(await hearOnline(messenger, sent, "7", "5", choice())).toEqual(tone)
  })

  it("never asks the messenger with --local, and never falls back when told to use the messenger", async () => {
    let asked = false
    const counting = adapter(async () => {
      asked = true
      return { text: "", pending: false }
    })

    expect(await hearOnline(messenger, counting, "7", "5", choice({ with: "local" }))).toEqual(tone)
    expect(asked).toBe(false)
    await expect(hearOnline(messenger, adapter(refusing), "7", "5", choice({ with: "messenger" }))).rejects.toThrow(
      "no Premium",
    )
  })

  it("hears with the recognizer a choice hands in, in place of the downloaded model", async () => {
    const open = () => ({ recognize: () => "handed in", free: () => {} })

    expect((await hearLocally(tone, "5", choice({ open }))).text).toBe("handed in")
  })

  it("**never sends audio to OpenAI on auto**, even with a key at hand", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: "remote" })))
    const auto = choice({ apiKey: "sk-synthetic", fetch })

    const bytes = await hearOnline(messenger, adapter(refusing), "7", "5", auto)

    expect((await hearLocally(bytes as Uint8Array, "5", auto)).via).toBe("local")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("**sends a voice message to OpenAI when chosen**, without asking the messenger or needing a local model", async () => {
    let asked = false
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: "remote" })))
    const openai = choice({ with: "openai", apiKey: "sk-synthetic", fetch, directory: directoryWithVad() })
    const counting = adapter(async () => {
      asked = true
      return { text: "", pending: false }
    })

    const bytes = await hearOnline(messenger, counting, "7", "5", openai)

    expect(asked).toBe(false)
    expect(await hearLocally(bytes as Uint8Array, "5", openai)).toEqual({
      messageId: "5",
      text: "remote",
      pending: false,
      via: "openai",
      model: "gpt-transcribe",
    })
    const refused = new CliError("authentication_error", "no OpenAI key")
    await expect(hearOnline(messenger, counting, "7", "5", choice({ with: "openai", refusal: refused }))).rejects.toBe(
      refused,
    )
  })

  it("**names the download command instead of downloading** a missing model", async () => {
    await expect(
      hearOnline(messenger, adapter(refusing), "7", "5", choice({ directory: directoryWithVad() })),
    ).rejects.toThrow(/chat models download parakeet-v3/)
  })
})

it("the public speech directory respects an explicit WireCat folder without creating it", () => {
  const cache = join(mkdtempSync(join(tmpdir(), "speech-export-")), "absent")
  expect(modelsDirectory({ WIRECAT_STATE_DIR: cache })).toBe(join(cache, "models", "audio"))
  expect(isInstalled(speechModel("gigaam-v3"), modelsDirectory({ WIRECAT_STATE_DIR: cache }))).toBe(false)
})

it("repair verifies existing bytes, replaces a corrupt same-size file and reuses verified files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "speech-repair-"))
  const path = join(directory, "fixture.bin")
  const file = { name: "fixture.bin", bytes: 7, sha256: sha("weights"), url: "https://example.test/fixture.bin" }
  writeFileSync(path, "Weights")
  const fetch = vi.fn(serving("weights"))
  const progress = vi.fn()
  await installFiles([[file, path]], { verifyExisting: true, fetch, progress })
  expect(readFileSync(path, "utf8")).toBe("weights")
  expect(progress).toHaveBeenCalledWith(expect.stringContaining("not the file this version expects"))
  await installFiles([[file, path]], { verifyExisting: true, fetch })
  expect(fetch).toHaveBeenCalledTimes(1)
})
