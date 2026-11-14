import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  decodeAudio,
  decodeChannels,
  decodeChannelsFile,
  formatOf,
  LONGEST_AUDIO_SECONDS,
  runFfmpeg,
  wavStream,
} from "./decode.js"
import { SAMPLE_RATE } from "./recognize.js"

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../testing/fixtures/${name}`, import.meta.url)))
const refusing = async () => {
  throw new Error("ffmpeg was asked")
}
const pcm = (seconds: number) => ({ samples: new Float32Array(seconds * SAMPLE_RATE), rate: SAMPLE_RATE })
const seconds = ({ samples, rate }: { samples: Float32Array; rate: number }) => samples.length / rate

describe("decoding audio for the model", () => {
  it.each([
    ["tone.ogg", "opus"],
    ["tone.vorbis.ogg", "vorbis"],
    ["tone.flac", "flac"],
    ["tone.mp3", "mp3"],
  ])("**reads %s with a bundled decoder**, never ffmpeg", async (name, format) => {
    const bytes = fixture(name)

    expect(formatOf(bytes)).toBe(format)
    expect(seconds(await decodeAudio(bytes, refusing))).toBeCloseTo(1, 0)
  })

  it("**keeps each channel of a stereo call apart**, and hands the first to callers that want one", async () => {
    const { channels, mixed } = await decodeChannels(fixture("dialogue.mp3"), refusing)
    const loudness = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length)

    expect([channels.length, mixed]).toEqual([2, false])
    const [left, right] = channels.map(({ samples }) => samples) as [Float32Array, Float32Array]
    expect(left.length).toBe(right.length)
    expect(loudness(left.map((x, i) => x - (right[i] ?? 0)))).toBeGreaterThan(0.01)
    const one = (await decodeAudio(fixture("dialogue.mp3"), refusing)).samples
    expect(one[1000]).toBeCloseTo(((left[1000] ?? 0) + (right[1000] ?? 0)) / 2, 6)
  })

  it("**keeps the channels ffmpeg hands back apart**, and says mixed only for a decoder that answers one", async () => {
    const two = vi.fn(async () => [pcm(1), pcm(1)])
    const one = vi.fn(async () => pcm(1))

    expect(await decodeChannels(fixture("tone.aac"), two)).toMatchObject({ mixed: false, channels: [{}, {}] })
    expect(await decodeChannels(fixture("tone.aac"), one)).toMatchObject({ mixed: true, channels: [{}] })
    expect((await decodeChannels(fixture("tone.mp3"), refusing)).mixed).toBe(false)
  })

  it("**hands raw AAC to ffmpeg**, though its frames start like MP3's", async () => {
    const ffmpeg = vi.fn(async () => ({ samples: new Float32Array(SAMPLE_RATE), rate: SAMPLE_RATE }))

    expect(formatOf(fixture("tone.aac"))).toBe("other")
    expect(seconds(await decodeAudio(fixture("tone.aac"), ffmpeg))).toBe(1)
  })

  it("**tries ffmpeg when a bundled decoder cannot read the file**, and keeps that decoder's error without it", async () => {
    const broken = fixture("tone.ogg").subarray(0, 200)
    const ffmpeg = vi.fn(async () => ({ samples: new Float32Array(SAMPLE_RATE), rate: SAMPLE_RATE }))

    expect(formatOf(broken)).toBe("opus")
    expect(seconds(await decodeAudio(broken, ffmpeg))).toBe(1)
    await expect(decodeAudio(broken, refusing)).rejects.toThrow("complete mono or stereo Ogg Opus")
  })

  it("**hands an iPhone recording (MP4) to ffmpeg**, and anything else it cannot name", async () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x20, ...Buffer.from("ftypM4A ")])
    const ffmpeg = vi.fn(async () => ({ samples: new Float32Array(SAMPLE_RATE), rate: SAMPLE_RATE }))

    expect(seconds(await decodeAudio(mp4, ffmpeg))).toBe(1)
    expect(ffmpeg).toHaveBeenCalledWith(mp4)
  })

  it("refuses audio longer than an hour", async () => {
    const long = async () => ({ samples: new Float32Array(LONGEST_AUDIO_SECONDS + 1), rate: 1 })

    await expect(decodeAudio(new Uint8Array(8), long)).rejects.toThrow("longer than 60 minutes")
  })

  it("**says when only ffmpeg reads the format and the machine has none**", async () => {
    vi.stubEnv("PATH", "/nonexistent")
    try {
      await expect(runFfmpeg(new Uint8Array(8))).rejects.toThrow("ffmpeg is not installed")
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

/** What ffmpeg writes to a pipe: 32-bit float WAV whose sizes are placeholders. */
const floatWav = (channels: number, frames: number[][], { extra = true } = {}) => {
  const fmt = Buffer.alloc(26)
  fmt.write("fmt ", 0, "latin1")
  fmt.writeUInt32LE(18, 4)
  fmt.writeUInt16LE(3, 8)
  fmt.writeUInt16LE(channels, 10)
  fmt.writeUInt32LE(SAMPLE_RATE, 12)
  fmt.writeUInt32LE(SAMPLE_RATE * channels * 4, 16)
  fmt.writeUInt16LE(channels * 4, 20)
  fmt.writeUInt16LE(32, 22)
  const list = Buffer.concat([Buffer.from("LIST", "latin1"), Buffer.from([3, 0, 0, 0]), Buffer.from("abc\0", "latin1")])
  const data = Buffer.alloc(frames.length * channels * 4)
  frames.forEach((frame, index) => {
    frame.forEach((value, channel) => {
      data.writeFloatLE(value, (index * channels + channel) * 4)
    })
  })
  return Buffer.concat([
    Buffer.from("RIFF\xff\xff\xff\xffWAVE", "latin1"),
    fmt,
    ...(extra ? [list] : []),
    Buffer.from("data\xff\xff\xff\xff", "latin1"),
    data,
  ])
}

describe("reading ffmpeg's WAV as it arrives", () => {
  it("**splits the interleaved samples into one array per channel**, across pieces cut anywhere", () => {
    const bytes = floatWav(2, [
      [0.5, -0.5],
      [0.25, -0.25],
      [0.125, -0.125],
    ])
    const wav = wavStream(10)
    let from = 0
    for (const to of [5, 30, 47, 59, 61, bytes.length]) {
      wav.push(bytes.subarray(from, to))
      from = to
    }
    const [left, right] = wav.end()

    expect([...(left?.samples ?? [])]).toEqual([0.5, 0.25, 0.125])
    expect([...(right?.samples ?? [])]).toEqual([-0.5, -0.25, -0.125])
    expect(left?.rate).toBe(SAMPLE_RATE)
  })

  it("keeps a mono file one channel", () => {
    const wav = wavStream(10)
    wav.push(floatWav(1, [[0.5], [0.25]], { extra: false }))

    expect(wav.end().map(({ samples }) => [...samples])).toEqual([[0.5, 0.25]])
  })

  it("**says stop once a channel passes the limit**, so ffmpeg is stopped before memory fills", () => {
    const wav = wavStream(2)

    expect(wav.push(floatWav(1, [[0], [0], [0]]))).toBe(false)
  })

  it("refuses an answer that is not float WAV", () => {
    expect(() => wavStream(2).push(Buffer.from("RIFF\0\0\0\0AVI LIST", "latin1"))).toThrow("did not answer with WAV")
  })
})

describe("decoding a file on disk", () => {
  const saved = (name: string, bytes: Uint8Array) => {
    const path = join(mkdtempSync(join(tmpdir(), "decode-")), name)
    writeFileSync(path, bytes)
    return path
  }

  it("**hands a WAV to ffmpeg by its path**, whatever its size", async () => {
    const path = saved("call.wav", new Uint8Array(Buffer.from("RIFF\0\0\0\0WAVEfmt ")))
    const ffmpegFile = vi.fn(async () => [pcm(1), pcm(1)])

    expect((await decodeChannelsFile(path, { maxBytes: 1, ffmpegFile })).channels).toHaveLength(2)
    expect(ffmpegFile).toHaveBeenCalledWith(path)
  })

  it("reads a bundled format whole, and refuses one over maxBytes", async () => {
    const path = saved("tone.mp3", fixture("tone.mp3"))

    expect(seconds((await decodeChannelsFile(path, { ffmpegFile: refusing })).channels[0] ?? pcm(0))).toBeCloseTo(1, 0)
    await expect(decodeChannelsFile(path, { maxBytes: 100, ffmpegFile: refusing })).rejects.toMatchObject({
      details: { reason: "file.too-large" },
    })
  })
})

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0

/** PCM16 WAV with a 440 Hz tone on the left and silence on the right, as a call recorder writes one side talking. */
const stereoCall = (rate = 8000, length = rate) => {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0, "latin1")
  header.writeUInt32LE(36 + length * 4, 4)
  header.write("WAVEfmt ", 8, "latin1")
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36, "latin1")
  header.writeUInt32LE(length * 4, 40)
  const data = Buffer.alloc(length * 4)
  for (let index = 0; index < length; index++)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 16000), index * 4)
  return new Uint8Array(Buffer.concat([header, data]))
}

const loud = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length)

describe.skipIf(!hasFfmpeg)("the machine's ffmpeg", () => {
  it("**keeps both sides of a stereo WAV call apart**", async () => {
    const { channels, mixed } = await decodeChannels(stereoCall())

    expect([channels.length, mixed]).toEqual([2, false])
    expect(channels[0]?.samples.length).toBe(SAMPLE_RATE)
    expect(loud(channels[0]?.samples ?? new Float32Array())).toBeGreaterThan(0.2)
    expect(loud(channels[1]?.samples ?? new Float32Array())).toBeLessThan(0.01)
  })

  it("**reads a WAV on disk by its path**, without reading it into memory first", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "decode-")), "call.wav")
    writeFileSync(path, stereoCall())
    const { channels } = await decodeChannelsFile(path, { maxBytes: 10 })

    expect(channels.map(({ samples }) => samples.length)).toEqual([SAMPLE_RATE, SAMPLE_RATE])
  })
})
