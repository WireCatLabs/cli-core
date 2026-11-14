import { spawn } from "node:child_process"
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
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

/** One `Pcm` per channel; a decoder written before channels were kept may still answer one mixed `Pcm`. */
export type Ffmpeg = (bytes: Uint8Array) => Promise<Pcm | Pcm[]>

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

const everyChannel = (decoded: { channelData: Float32Array[]; samplesDecoded: number; sampleRate: number }): Pcm[] => {
  if (!decoded.channelData[0] || decoded.samplesDecoded === 0)
    throw new CliError("validation_error", "no audio in that file")
  return decoded.channelData.map((samples) => ({ samples, rate: decoded.sampleRate }))
}

/**
 * Found from cli-core's own place and imported by URL, so a CLI's bundler leaves the decoder whole: bundled, it looks
 * for its worker file beside the bundle, where there is none.
 */
const load = <T>(name: string): Promise<T> =>
  import(pathToFileURL(createRequire(import.meta.url).resolve(name)).href) as Promise<T>

const decodeVorbis = async (bytes: Uint8Array): Promise<Pcm[]> => {
  const { OggVorbisDecoder } = await load<typeof import("@wasm-audio-decoders/ogg-vorbis")>(
    "@wasm-audio-decoders/ogg-vorbis",
  )
  const decoder = new OggVorbisDecoder()
  await decoder.ready
  try {
    return everyChannel(await decoder.decodeFile(bytes))
  } finally {
    decoder.free()
  }
}

const decodeFlac = async (bytes: Uint8Array): Promise<Pcm[]> => {
  const { FLACDecoder } = await load<typeof import("@wasm-audio-decoders/flac")>("@wasm-audio-decoders/flac")
  const decoder = new FLACDecoder()
  await decoder.ready
  try {
    return everyChannel(await decoder.decodeFile(bytes))
  } finally {
    decoder.free()
  }
}

const decodeMp3 = async (bytes: Uint8Array): Promise<Pcm[]> => {
  const { MPEGDecoder } = await load<typeof import("mpg123-decoder")>("mpg123-decoder")
  const decoder = new MPEGDecoder()
  await decoder.ready
  try {
    return everyChannel(decoder.decode(bytes))
  } finally {
    decoder.free()
  }
}

const tooLongError = () =>
  new CliError("validation_error", `the audio is longer than ${LONGEST_AUDIO_SECONDS / 60} minutes`)

const FLOAT = 3
const LONGEST_HEADER = 64 * 1024
const EXTENSIBLE = 0xfffe

/**
 * The 32-bit float WAV ffmpeg writes to a pipe, read as it arrives: each channel's samples go to their own array at
 * once, so the interleaved bytes are never held whole. ffmpeg cannot seek back on a pipe, so the sizes in the header
 * are placeholders and the samples run to the end of the stream. `push` answers false once a channel passes `most`
 * samples.
 */
export const wavStream = (most: number) => {
  let head: Buffer = Buffer.alloc(0)
  let channels = 0
  let rate = 0
  let rest: Buffer = Buffer.alloc(0)
  let length = 0
  let parts: Float32Array[][] = []
  const header = (): boolean => {
    if (head.length < 12) return false
    if (head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE")
      throw new CliError("validation_error", "ffmpeg did not answer with WAV audio")
    for (let at = 12; at + 8 <= head.length; ) {
      const id = head.toString("latin1", at, at + 4)
      const size = head.readUInt32LE(at + 4)
      if (id === "data") {
        rest = head.subarray(at + 8)
        head = Buffer.alloc(0)
        return true
      }
      if (at + 8 + size > head.length) return false
      if (id === "fmt ") {
        const tag = head.readUInt16LE(at + 8)
        channels = head.readUInt16LE(at + 10)
        rate = head.readUInt32LE(at + 12)
        if ((tag !== FLOAT && tag !== EXTENSIBLE) || head.readUInt16LE(at + 22) !== 32 || channels < 1)
          throw new CliError("validation_error", "ffmpeg did not answer with 32-bit float samples")
        parts = Array.from({ length: channels }, () => [])
      }
      at += 8 + size + (size % 2)
    }
    return false
  }
  return {
    push: (chunk: Buffer): boolean => {
      if (channels === 0 || head.length > 0) {
        head = Buffer.concat([head, chunk])
        if (head.length > LONGEST_HEADER) throw new CliError("validation_error", "ffmpeg's WAV header never ended")
        if (!header()) return true
        chunk = Buffer.alloc(0)
      }
      const bytes = rest.length ? Buffer.concat([rest, chunk]) : chunk
      const frame = channels * 4
      const frames = Math.floor(bytes.length / frame)
      rest = Buffer.from(bytes.subarray(frames * frame))
      if (frames === 0) return length <= most
      const view = new DataView(bytes.buffer, bytes.byteOffset, frames * frame)
      for (let channel = 0; channel < channels; channel++) {
        const samples = new Float32Array(frames)
        for (let index = 0; index < frames; index++) samples[index] = view.getFloat32(index * frame + channel * 4, true)
        parts[channel]?.push(samples)
      }
      length += frames
      return length <= most
    },
    end: (): Pcm[] => {
      if (channels === 0) throw new CliError("validation_error", "no audio in that file")
      return parts.map((pieces, channel) => {
        const samples = new Float32Array(length)
        let at = 0
        for (const piece of pieces) {
          samples.set(piece, at)
          at += piece.length
        }
        // Each channel's pieces are let go once joined, so the peak stays near one copy of the samples, not two.
        parts[channel] = []
        return { samples, rate }
      })
    },
  }
}

/**
 * The owner's own ffmpeg on a file, for what no bundled decoder reads — AAC above all, which every small decoder does
 * under the GPL; Asterisk's WAV and GSM too. A mono file stays one channel and a stereo call two, one speaker each; a
 * file of more channels is mixed down to two. From a file rather than a pipe: an MP4 whose index sits at the end
 * cannot be read from a pipe. Stops past an hour of audio, so a channel holds at most an hour of 16 kHz samples.
 */
export const runFfmpegFile = (path: string): Promise<Pcm[]> =>
  new Promise<Pcm[]>((resolve, reject) => {
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
        path,
        "-vn",
        "-af",
        "aformat=channel_layouts=mono|stereo",
        "-ar",
        String(SAMPLE_RATE),
        "-c:a",
        "pcm_f32le",
        "-bitexact",
        "-f",
        "wav",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: FFMPEG_TIMEOUT_MS },
    )
    const wav = wavStream(LONGEST_AUDIO_SECONDS * SAMPLE_RATE)
    let long = false
    let broken: unknown
    let errors = ""
    child.stdout.on("data", (chunk: Buffer) => {
      if (long || broken) return
      try {
        long = !wav.push(chunk)
      } catch (error) {
        broken = error
      }
      if (long || broken) child.kill()
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
      if (long) return reject(tooLongError())
      if (broken) return reject(broken)
      if (code !== 0)
        return reject(new CliError("validation_error", `ffmpeg could not read the audio: ${errors.trim() || code}`))
      try {
        resolve(wav.end())
      } catch (error) {
        reject(error)
      }
    })
  })

/** `runFfmpegFile` on bytes already in memory, through a private temporary file. */
export const runFfmpeg = async (bytes: Uint8Array): Promise<Pcm[]> => {
  const directory = await mkdtemp(join(tmpdir(), "wirecat-audio-"))
  try {
    const input = join(directory, "audio")
    await writeFile(input, bytes, { mode: 0o600 })
    return await runFfmpegFile(input)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const BUNDLED: Record<Exclude<Format, "other">, (bytes: Uint8Array) => Promise<Pcm[]>> = {
  opus: decodeOgg,
  vorbis: decodeVorbis,
  flac: decodeFlac,
  mp3: decodeMp3,
}

const tooLong = (pcm: Pcm): boolean => pcm.samples.length / pcm.rate > LONGEST_AUDIO_SECONDS

export interface DecodedChannels {
  channels: Pcm[]
  /**
   * True when the channels arrived mixed into one, so one speaker per channel is lost: only when a caller's own
   * `Ffmpeg` answers a single `Pcm`. The bundled decoders and `runFfmpeg` keep a stereo file's channels apart.
   */
  mixed: boolean
}

const fromFfmpeg = (answer: Pcm | Pcm[]): DecodedChannels =>
  Array.isArray(answer) ? { channels: answer, mixed: false } : { channels: [answer], mixed: true }

/**
 * Every channel the file has, one `Pcm` each: a phone call recorded in stereo keeps one speaker per channel. Opus,
 * Vorbis, FLAC and MP3 by the bundled decoders; anything else, or what one of them could not read, by ffmpeg when the
 * machine has it. The bundled decoder's error wins: it names the file's own problem.
 */
export const decodeChannels = async (bytes: Uint8Array, ffmpeg: Ffmpeg = runFfmpeg): Promise<DecodedChannels> => {
  const format = formatOf(bytes)
  const decoded =
    format === "other"
      ? fromFfmpeg(await ffmpeg(bytes))
      : await BUNDLED[format](bytes).then(
          (channels) => ({ channels, mixed: false }),
          (error: unknown) =>
            ffmpeg(bytes).then(fromFfmpeg, () => {
              throw error
            }),
        )
  if (decoded.channels.length === 0) throw new CliError("validation_error", "no audio in that file")
  if (decoded.channels.some(tooLong)) throw tooLongError()
  return decoded
}

/**
 * The channels of a file on disk, for a recording too large to read into memory first: what ffmpeg reads (WAV, GSM,
 * AAC…) goes to it by path, and only the samples are held. A format a bundled decoder reads is read whole, at most
 * `maxBytes` (64 MB when not given): those decoders take bytes, and a compressed file decodes to many times its size.
 */
export const decodeChannelsFile = async (
  path: string,
  {
    maxBytes = 64 * 1024 * 1024,
    ffmpegFile = runFfmpegFile,
  }: { maxBytes?: number; ffmpegFile?: (path: string) => Promise<Pcm[]> } = {},
): Promise<DecodedChannels> => {
  const file = await open(path, "r")
  let start: Uint8Array
  let size: number
  try {
    size = (await file.stat()).size
    const head = Buffer.alloc(Math.min(size, 128))
    await file.read(head, 0, head.length, 0)
    start = head
  } finally {
    await file.close()
  }
  if (formatOf(start) === "other") {
    const channels = await ffmpegFile(path)
    if (channels.some(tooLong)) throw tooLongError()
    return { channels, mixed: false }
  }
  if (size > maxBytes)
    throw new CliError("validation_error", `the audio file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`, {
      reason: "file.too-large",
    })
  return decodeChannels(new Uint8Array(await readFile(path)), () => ffmpegFile(path))
}

/** Every channel averaged into one, so a caller that wants one text keeps both sides of a stereo recording. */
export const mixDown = (channels: readonly Pcm[]): Pcm => {
  const [first] = channels
  if (!first) throw new CliError("validation_error", "no audio in that file")
  if (channels.length === 1) return first
  const length = channels.reduce((longest, { samples }) => Math.max(longest, samples.length), 0)
  const samples = new Float32Array(length)
  for (const channel of channels)
    for (let index = 0; index < channel.samples.length; index++)
      samples[index] = (samples[index] ?? 0) + (channel.samples[index] ?? 0) / channels.length
  return { samples, rate: first.rate }
}

/** One voice for a caller that wants the text and not the turns, a voice message: the channels mixed into one. */
export const decodeAudio = async (bytes: Uint8Array, ffmpeg: Ffmpeg = runFfmpeg): Promise<Pcm> =>
  mixDown((await decodeChannels(bytes, ffmpeg)).channels)
