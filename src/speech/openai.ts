import { setTimeout as wait } from "node:timers/promises"
import { backoffMs, CliError, DEFAULT_RETRY, type RetryConfig } from "@wirecat/cli-base"
import { providerWaitMs } from "@wirecat/cli-base/http"
import { errorCode, type Fetch, OPENAI_URL } from "../embeddings/remote.js"
import type { Pcm } from "./decode.js"
import { filesPresent, modelsDirectory, vadPath } from "./install.js"
import { OPENAI_TRANSCRIBE_MODEL, VAD } from "./models.js"
import { SAMPLE_RATE, type SpeechCutter, type TimedText, toModelRate } from "./recognize.js"
import { encodeWav } from "./wav.js"

/** OpenAI's limit per file (speech-to-text guide, read 2026-10-31). */
export const OPENAI_LARGEST_FILE = 25 * 1024 * 1024

/** Ten minutes of 16 kHz PCM16 is 19 MB: under the limit with room for the header. */
const LONGEST_PIECE_SECONDS = 600

/** Speech the detector cut only because it ran past 20 seconds, with no pause between: never a place to split. */
const JOINED_SECONDS = 0.05

/** Kept around each piece so its first and last sounds are not clipped; never reaches into the next piece. */
const PAD_SECONDS = 0.2

const LEAD = SAMPLE_RATE / 2

export interface OpenAITranscription {
  apiKey: string
  /** `gpt-transcribe` when not given. */
  model?: string
  /** ISO-639-1 codes the speech may be in. Sent as `languages`; the singular `language` is never sent with it. */
  languages?: readonly string[]
  prompt?: string
  keywords?: readonly string[]
  baseUrl?: string
  signal?: AbortSignal
  fetch?: Fetch
  /**
   * Cut at pauses into pieces of at most this many seconds, each sent alone, so each piece has its own time: what
   * merging two channels into a dialogue needs. Without it the recording goes in one request when it fits.
   */
  pieceSeconds?: number
  /** The voice detector model, needed whenever the audio is cut; the shared models directory's when not given. */
  vadModel?: string
  env?: NodeJS.ProcessEnv
  /** Seams for tests: the detector, the retry policy and the clock. */
  cutter?: (vadModel: string) => SpeechCutter
  retry?: RetryConfig
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

const RETRY: RetryConfig = { ...DEFAULT_RETRY, retries: 4 }

const sleeping = (ms: number, signal?: AbortSignal): Promise<void> =>
  wait(ms, undefined, signal ? { signal } : {}).then(() => undefined)

const interrupted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return
  if (signal.reason instanceof CliError) throw signal.reason
  const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
  throw new CliError(timeout ? "timeout" : "cancelled", "the transcription was interrupted")
}

const formOf = (wav: Uint8Array, options: OpenAITranscription): FormData => {
  const form = new FormData()
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav")
  form.append("model", options.model ?? OPENAI_TRANSCRIBE_MODEL)
  // Repeated `name[]` fields: how OpenAI's own SDK sends an array in a multipart body.
  for (const language of options.languages ?? []) form.append("languages[]", language)
  for (const keyword of options.keywords ?? []) form.append("keywords[]", keyword)
  if (options.prompt) form.append("prompt", options.prompt)
  return form
}

/** One file, one request. 429, 408 and server errors are tried again; the provider's `Retry-After` beats our backoff. */
const send = async (wav: Uint8Array, options: OpenAITranscription): Promise<string> => {
  const post = options.fetch ?? fetch
  const retry = options.retry ?? RETRY
  const sleep = options.sleep ?? sleeping
  const random = options.random ?? Math.random
  const url = `${(options.baseUrl ?? OPENAI_URL).replace(/\/+$/, "")}/audio/transcriptions`
  for (let attempt = 1; ; attempt++) {
    interrupted(options.signal)
    let response: Response
    try {
      response = await post(url, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}` },
        body: formOf(wav, options),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch {
      interrupted(options.signal)
      if (attempt > retry.retries)
        throw new CliError("network_error", "OpenAI could not be reached", { reason: "network.failed" })
      await sleep(backoffMs(attempt, retry, random), options.signal)
      continue
    }
    if (response.ok) {
      const body = (await response.json().catch(() => undefined)) as { text?: unknown } | undefined
      if (typeof body?.text !== "string")
        throw new CliError("invalid_response", "OpenAI answered without a transcript", {
          reason: "provider.invalid-response",
        })
      return body.text.trim()
    }
    const code = await errorCode(response)
    const status = response.status
    if (status === 401 || status === 403)
      throw new CliError(
        "authentication_error",
        `OpenAI refused the key (HTTP ${status}${code}) — set it again with \`models keys set openai\``,
        { reason: "auth.failed" },
      )
    if (status === 413)
      throw new CliError("validation_error", `OpenAI refused the audio as too large (HTTP 413${code})`, {
        reason: "transcription.too-large",
      })
    const again = status === 408 || status === 429 || status >= 500
    const asked = providerWaitMs(response.headers, () => new Date())
    if (again && attempt <= retry.retries && (asked === undefined || asked <= retry.maxRetryAfterMs)) {
      await sleep(asked ?? backoffMs(attempt, retry, random), options.signal)
      continue
    }
    if (status === 429)
      throw new CliError("rate_limited", `OpenAI answered HTTP 429${code}`, {
        reason: "provider.rate-limited",
        ...(asked === undefined ? {} : { retry_after_ms: asked }),
      })
    if (status >= 500)
      throw new CliError(
        [502, 503, 504].includes(status) ? "provider_unavailable" : "provider_error",
        `OpenAI answered HTTP ${status}${code}`,
        { reason: [502, 503, 504].includes(status) ? "provider.unavailable" : "provider.refused" },
      )
    throw new CliError("provider_error", `OpenAI answered HTTP ${status}${code}`, { reason: "provider.refused" })
  }
}

/** Neighbouring stretches of speech, joined while the piece stays within `limit`; a stretch longer than it stays alone. */
export const piecesOf = (spans: readonly { start: number; end: number }[], limit: number) => {
  const pieces: { start: number; end: number }[] = []
  for (const span of spans) {
    const last = pieces.at(-1)
    const joined = last !== undefined && span.start - last.end < JOINED_SECONDS
    const fits = last !== undefined && span.end - last.start <= limit
    if (last && (fits || (joined && span.end - last.start <= LONGEST_PIECE_SECONDS))) last.end = span.end
    else pieces.push({ start: span.start, end: span.end })
  }
  return pieces
}

const openCutter = async (vadModel: string): Promise<SpeechCutter> => {
  const { openSpeechCutter } = await import("./recognize.js")
  return openSpeechCutter(vadModel)
}

/**
 * Speech to text by OpenAI's `/audio/transcriptions`, from one channel's samples. The answer is the recording's
 * pieces with their times: one piece for a recording sent whole, or one per piece the voice detector cut at pauses —
 * when `pieceSeconds` asks for it, or when the whole recording is over OpenAI's 25 MB. A piece is never cut mid-word.
 * `gpt-transcribe` gives no timestamps of its own, so a piece's time is where the detector found it.
 */
export const transcribeOpenAI = async (audio: Pcm, options: OpenAITranscription): Promise<TimedText[]> => {
  if (!options.apiKey)
    throw new CliError("authentication_error", "no OpenAI key — `models keys set openai`, or OPENAI_API_KEY", {
      reason: "transcription.no-key",
    })
  if (options.pieceSeconds !== undefined && !(options.pieceSeconds > 0))
    throw new CliError("validation_error", "pieceSeconds must be a positive number of seconds")
  interrupted(options.signal)
  const pcm = toModelRate(audio.samples, audio.rate)
  const duration = (pcm.length - LEAD) / SAMPLE_RATE
  if (options.pieceSeconds === undefined && 44 + (pcm.length - LEAD) * 2 <= OPENAI_LARGEST_FILE) {
    const text = await send(encodeWav(pcm.subarray(LEAD)), options)
    return text ? [{ start: 0, end: duration, text }] : []
  }
  const vadModel = options.vadModel ?? vadPath(modelsDirectory(options.env))
  if (!options.cutter && !filesPresent([[VAD, vadModel]]))
    throw new CliError(
      "not_found",
      "the voice detector that cuts long audio at pauses is not on this machine — it comes with any speech model: `models download`",
      { reason: "model.not-downloaded", model: "silero_vad" },
    )
  const cutter = await (options.cutter ?? openCutter)(vadModel)
  let spans: { start: number; end: number }[]
  try {
    spans = cutter.cut(pcm)
  } finally {
    cutter.free()
  }
  const pieces = piecesOf(spans, Math.min(options.pieceSeconds ?? LONGEST_PIECE_SECONDS, LONGEST_PIECE_SECONDS))
  const heard: TimedText[] = []
  for (const [index, piece] of pieces.entries()) {
    const from = Math.max(piece.start - PAD_SECONDS, pieces[index - 1]?.end ?? 0)
    const to = Math.min(piece.end + PAD_SECONDS, pieces[index + 1]?.start ?? duration)
    const samples = pcm.subarray(LEAD + Math.floor(from * SAMPLE_RATE), LEAD + Math.ceil(to * SAMPLE_RATE))
    const text = await send(encodeWav(samples), options)
    if (text) heard.push({ start: piece.start, end: piece.end, text })
  }
  return heard
}
