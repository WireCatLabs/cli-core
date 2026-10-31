import { createRequire } from "node:module"
import type { SpeechModel } from "./models.js"
import { checkOggDuration } from "./ogg-limit.js"

/** Seconds from the start of the recording. */
export interface TimedText {
  start: number
  end: number
  text: string
}

/** What transcription needs from a speech engine — small enough for a test to stand in for it. */
export interface Recognizer {
  recognize(pcm: Float32Array): string
  /** Each stretch of speech the voice detector cut, with where it lies; the same input as `recognize`. */
  pieces?(pcm: Float32Array): TimedText[]
  free(): void
}

export const SAMPLE_RATE = 16_000

/**
 * Half a second of silence ahead of the speech. Without it the voice detector clipped a recording
 * that starts talking at once: "Ничьих" came back as "чьих" (measured 2026-09-24).
 */
const LEAD = SAMPLE_RATE / 2

/**
 * Voice messages are Ogg Opus at 48 kHz (measured on a MAX one), and the models want 16 kHz. Averaging each three samples is ours rather than the engine's resampler, which announces
 * itself on stderr on every call.
 */
export const toModelRate = (samples: Float32Array, rate: number): Float32Array => {
  const step = rate / SAMPLE_RATE
  const length = Math.floor(samples.length / step)
  const pcm = new Float32Array(LEAD + length)
  for (let i = 0; i < length; i++) {
    const from = Math.floor(i * step)
    const to = Math.max(from + 1, Math.floor((i + 1) * step))
    let sum = 0
    for (let j = from; j < to; j++) sum += samples[j] ?? 0
    pcm[LEAD + i] = sum / (to - from)
  }
  return pcm
}

export const decodeOgg = async (bytes: Uint8Array): Promise<{ samples: Float32Array; rate: number }[]> => {
  checkOggDuration(bytes)
  const { OggOpusDecoder } = await import("ogg-opus-decoder")
  const decoder = new OggOpusDecoder()
  await decoder.ready
  try {
    const { channelData, sampleRate, samplesDecoded } = await decoder.decodeFile(bytes)
    if (!channelData[0] || samplesDecoded === 0) throw new Error("no Ogg Opus audio in it")
    return channelData.map((samples) => ({ samples, rate: sampleRate }))
  } finally {
    decoder.free()
  }
}

interface SherpaStream {
  acceptWaveform(rate: number, samples: Float32Array): void
  free(): void
}
interface Sherpa {
  createOfflineRecognizer(config: object): {
    createStream(): SherpaStream
    decode(stream: SherpaStream): void
    getResult(stream: SherpaStream): { text: string }
    free(): void
  }
  createVad(config: object): {
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    front(): { start: number; samples: Float32Array }
    pop(): void
    flush(): void
    reset(): void
    free(): void
  }
}

const WINDOW = 512

/** Where the voice detector cuts. Tested on a recording with a quiet stretch in the middle (`speech.test.ts`). */
export const detector = (vadModel: string) => ({
  sileroVad: {
    model: vadModel,
    // At the default 0.5 a quietly spoken stretch in the middle of a voice message never counted as
    // speech and was lost; 0.3 keeps it for both models and changes nothing on clear speech (126508, 2026-09-30).
    threshold: 0.3,
    minSilenceDuration: 0.5,
    minSpeechDuration: 0.25,
    maxSpeechDuration: 20,
    windowSize: WINDOW,
  },
  sampleRate: SAMPLE_RATE,
  numThreads: 1,
  provider: "cpu",
  debug: 0,
  bufferSizeInSeconds: 30,
})

export interface SpeechSpan {
  start: number
  end: number
  samples: Float32Array
}

type Vad = ReturnType<Sherpa["createVad"]>

/**
 * `pcm` as `toModelRate` made it: the detector's sample offsets count its half-second lead, the recording does not.
 * Each stretch goes to `each` as it is cut, so an hour of speech is never held twice.
 */
const cut = (vad: Vad, pcm: Float32Array, each: (span: SpeechSpan) => void): void => {
  // One detector can hear several recordings in a row; nothing of the last may leak into this one.
  vad.reset()
  const last = Math.max(0, pcm.length - LEAD)
  const drain = () => {
    for (; !vad.isEmpty(); vad.pop()) {
      const { start, samples } = vad.front()
      each({
        start: Math.min(last, Math.max(0, start - LEAD)) / SAMPLE_RATE,
        end: Math.min(last, Math.max(0, start + samples.length - LEAD)) / SAMPLE_RATE,
        samples,
      })
    }
  }
  for (let i = 0; i + WINDOW <= pcm.length; i += WINDOW) {
    vad.acceptWaveform(pcm.subarray(i, i + WINDOW))
    drain()
  }
  vad.flush()
  drain()
}

export interface SpeechCutter {
  /** Where the speech is, in seconds of the recording; `pcm` as `toModelRate` made it. */
  cut(pcm: Float32Array): { start: number; end: number }[]
  free(): void
}

/** The voice detector alone, for a recognizer that is not on this machine. */
export const openSpeechCutter = (vadModel: string): SpeechCutter => {
  const vad = loadSherpa().createVad(detector(vadModel))
  return {
    cut: (pcm) => {
      const spans: { start: number; end: number }[] = []
      cut(vad, pcm, ({ start, end }) => spans.push({ start, end }))
      return spans
    },
    free: () => vad.free(),
  }
}

/**
 * The model, and a voice detector that cuts the audio at pauses into pieces of at most 20 seconds.
 * The cutting is not optional: five minutes in one piece crash the WebAssembly build (measured).
 *
 * `sherpa-onnx` is loaded here, on first use, so no other command pays for its 15 MB of WebAssembly.
 */
let loaded: Sherpa | undefined

/**
 * The engine's WebAssembly writes its logs (a growing buffer says "Overflow! … No data loss!") with
 * `printf`, which its file system sends straight to file descriptor 1 and so into `--json` output.
 * `sherpa-onnx`'s own entry keeps that file system to itself; built here, descriptor 1 is pointed at 2.
 */
export const loadSherpa = (): Sherpa => {
  if (loaded) return loaded
  const load = createRequire(import.meta.url)
  const wasm: { FS?: { getStream(fd: number): { nfd: number } | null } } = {}
  load("sherpa-onnx/sherpa-onnx-wasm-nodejs.js")(wasm)
  const stdout = wasm.FS?.getStream(1)
  if (stdout) stdout.nfd = 2
  const asr = load("sherpa-onnx/sherpa-onnx-asr.js")
  const vad = load("sherpa-onnx/sherpa-onnx-vad.js")
  loaded = {
    createOfflineRecognizer: (config) => new asr.OfflineRecognizer(config, wasm),
    createVad: (config) => vad.createVad(wasm, config),
  }
  return loaded
}

export const openRecognizer = (model: SpeechModel, path: (name: string) => string, vadModel: string): Recognizer => {
  const sherpa = loadSherpa()
  const engine = sherpa.createOfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: model.featureDim },
    modelConfig: { ...model.config(path), numThreads: 1, provider: "cpu", debug: 0 },
    decodingMethod: "greedy_search",
  })
  const vad = sherpa.createVad(detector(vadModel))

  const piece = (samples: Float32Array): string => {
    const stream = engine.createStream()
    try {
      stream.acceptWaveform(SAMPLE_RATE, samples)
      engine.decode(stream)
      return engine.getResult(stream).text.trim()
    } finally {
      stream.free()
    }
  }

  const pieces = (pcm: Float32Array): TimedText[] => {
    const heard: TimedText[] = []
    cut(vad, pcm, ({ start, end, samples }) => {
      const text = piece(samples)
      if (text) heard.push({ start, end, text })
    })
    return heard
  }

  return {
    recognize: (pcm) =>
      pieces(pcm)
        .map(({ text }) => text)
        .join(" "),
    pieces,
    free: () => {
      vad.free()
      engine.free()
    },
  }
}
