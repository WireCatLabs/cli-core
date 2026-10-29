import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { decodeOgg, SAMPLE_RATE } from "./recognize.js"

export interface Pcm {
  samples: Float32Array
  rate: number
}

/** An hour of speech; a longer "voice message" is a podcast or a song, and its samples would not fit in memory. */
export const LONGEST_AUDIO_SECONDS = 3600

const FFMPEG_TIMEOUT_MS = 120_000

/**
 * Formats a sender's file may claim to be. A playlist (HLS, concat) would make ffmpeg open other files and URLs,
 * so it never gets past this list or the file-only protocol list.
 */
const FFMPEG_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,aac,mp3,wav,amr,caf,aiff,flac,ogg,matroska,webm,asf"

export type Ffmpeg = (bytes: Uint8Array) => Promise<Pcm>

const text = (bytes: Uint8Array, from: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(from, from + length))

const contains = (bytes: Uint8Array, needle: string, within: number): boolean =>
  Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, within)).includes(needle, 0, "latin1")

type Format = "opus" | "vorbis" | "flac" | "mp3" | "other"

/** From the bytes, never the MIME type: WhatsApp calls an iPhone recording `audio/mp4` and a voice note `audio/ogg`. */
export const formatOf = (bytes: Uint8Array): Format => {
  if (text(bytes, 0, 4) === "OggS") {
    if (contains(bytes, "OpusHead", 128)) return "opus"
    if (contains(bytes, "\x01vorbis", 128)) return "vorbis"
    return "other"
  }
  if (text(bytes, 0, 4) === "fLaC") return "flac"
  // ADTS AAC shares MPEG's frame sync; its layer bits are 00, which MPEG audio reserves.
  const frame = bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0 && (((bytes[1] ?? 0) >> 1) & 3) !== 0
  if (text(bytes, 0, 3) === "ID3" || frame) return "mp3"
  return "other"
}

const firstChannel = (decoded: { channelData: Float32Array[]; samplesDecoded: number; sampleRate: number }): Pcm => {
  const samples = decoded.channelData[0]
  if (!samples || decoded.samplesDecoded === 0) throw new CliError("validation_error", "no audio in that file")
  return { samples, rate: decoded.sampleRate }
}

const decodeVorbis = async (bytes: Uint8Array): Promise<Pcm> => {
  const { OggVorbisDecoder } = await import("@wasm-audio-decoders/ogg-vorbis")
  const decoder = new OggVorbisDecoder()
  await decoder.ready
  try {
    return firstChannel(await decoder.decodeFile(bytes))
  } finally {
    decoder.free()
  }
}

const decodeFlac = async (bytes: Uint8Array): Promise<Pcm> => {
  const { FLACDecoder } = await import("@wasm-audio-decoders/flac")
  const decoder = new FLACDecoder()
  await decoder.ready
  try {
    return firstChannel(await decoder.decodeFile(bytes))
  } finally {
    decoder.free()
  }
}

const decodeMp3 = async (bytes: Uint8Array): Promise<Pcm> => {
  const { MPEGDecoder } = await import("mpg123-decoder")
  const decoder = new MPEGDecoder()
  await decoder.ready
  try {
    return firstChannel(decoder.decode(bytes))
  } finally {
    decoder.free()
  }
}

/**
 * The owner's own ffmpeg, for what no bundled decoder reads — AAC above all, which every small decoder does under
 * the GPL. From a file rather than a pipe: an MP4 whose index sits at the end cannot be read from a pipe.
 */
export const runFfmpeg: Ffmpeg = async (bytes) => {
  const directory = await mkdtemp(join(tmpdir(), "wirecat-audio-"))
  try {
    const input = join(directory, "audio")
    await writeFile(input, bytes, { mode: 0o600 })
    const largest = LONGEST_AUDIO_SECONDS * SAMPLE_RATE * 4
    const output = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        "ffmpeg",
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-protocol_whitelist",
          "file",
          "-format_whitelist",
          FFMPEG_FORMATS,
          "-i",
          input,
          "-vn",
          "-ac",
          "1",
          "-ar",
          String(SAMPLE_RATE),
          "-f",
          "f32le",
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"], timeout: FFMPEG_TIMEOUT_MS },
      )
      const chunks: Buffer[] = []
      let size = 0
      let errors = ""
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > largest) child.kill()
        else chunks.push(chunk)
      })
      child.stderr.on("data", (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-500)
      })
      child.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          error.code === "ENOENT"
            ? new CliError("validation_error", "only ffmpeg reads this audio format, and ffmpeg is not installed")
            : error,
        ),
      )
      child.on("close", (code) => {
        if (size > largest)
          reject(new CliError("validation_error", `the audio is longer than ${LONGEST_AUDIO_SECONDS / 60} minutes`))
        else if (code === 0) resolve(Buffer.concat(chunks))
        else reject(new CliError("validation_error", `ffmpeg could not read the audio: ${errors.trim() || code}`))
      })
    })
    const samples = new Float32Array(Math.floor(output.length / 4))
    Buffer.from(samples.buffer).set(output.subarray(0, samples.length * 4))
    return { samples, rate: SAMPLE_RATE }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const BUNDLED: Record<Exclude<Format, "other">, (bytes: Uint8Array) => Promise<Pcm>> = {
  opus: decodeOgg,
  vorbis: decodeVorbis,
  flac: decodeFlac,
  mp3: decodeMp3,
}

/**
 * Opus, Vorbis, FLAC and MP3 by the bundled decoders; anything else, or what one of them could not read, by ffmpeg
 * when the machine has it. The bundled decoder's error wins: it names the file's own problem.
 */
export const decodeAudio = async (bytes: Uint8Array, ffmpeg: Ffmpeg = runFfmpeg): Promise<Pcm> => {
  const format = formatOf(bytes)
  const pcm =
    format === "other"
      ? await ffmpeg(bytes)
      : await BUNDLED[format](bytes).catch((error: unknown) =>
          ffmpeg(bytes).catch(() => {
            throw error
          }),
        )
  if (pcm.samples.length / pcm.rate > LONGEST_AUDIO_SECONDS)
    throw new CliError("validation_error", `the audio is longer than ${LONGEST_AUDIO_SECONDS / 60} minutes`)
  return pcm
}
