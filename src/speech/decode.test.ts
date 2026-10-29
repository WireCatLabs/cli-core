import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { decodeAudio, formatOf, LONGEST_AUDIO_SECONDS, runFfmpeg } from "./decode.js"
import { SAMPLE_RATE } from "./recognize.js"

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../testing/fixtures/${name}`, import.meta.url)))
const refusing = async () => {
  throw new Error("ffmpeg was asked")
}
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
