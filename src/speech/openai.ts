import { setTimeout as wait } from "node:timers/promises"
import { backoffMs, CliError, DEFAULT_RETRY, type RetryConfig } from "@wirecat/cli-base"
import { providerWaitMs } from "@wirecat/cli-base/http"
import { type Fetch, OPENAI_URL } from "../embeddings/remote.js"
import type { Pcm } from "./decode.js"
import { filesPresent, modelsDirectory, vadPath } from "./install.js"
import { OPENAI_TRANSCRIBE_MODEL, VAD } from "./models.js"
import { SAMPLE_RATE, type SpeechCutter, type TimedText, toModelRate } from "./recognize.js"
import { encodeWav } from "./wav.js"

/**
 * Ten minutes of 16 kHz PCM16 is 19.2 MB: under OpenAI's 25 MB per file (speech-to-text guide, read 2026-10-31)
 * whichever megabyte it means, with room for the multipart body around it.
 */
export const LONGEST_REQUEST_SECONDS = 600

/**
 * The detector cuts speech that runs past 20 seconds with no pause; on real speech that cut left 0.074 s between the
 * two stretches, and the shortest real pause it found was 0.43 s. Below this the two are one stretch, cut mid-word.
 */
const JOINED_SECONDS = 0.2

/** Kept around each piece so its first and last sounds are not clipped; never reaches into the next piece. */
const PAD_SECONDS = 0.2

const LEAD = SAMPLE_RATE / 2

/** OpenAI's codes for money or limits run out (error-codes guide, read 2026-10-31): waiting does not help. */
const EXHAUSTED = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
])

export interface OpenAITranscription {
  apiKey: string
  /** `gpt-transcribe` when not given. */
  model?: string
  /** ISO-639-1 codes the speech may be in. Sent as `languages`; the singular `language` is never sent with it. */
  languages?: readonly string[]
  prompt?: string
  /** Literal terms expected in the speech; OpenAI refuses the whole request if one holds `<`, `>` or a line break. */
  keywords?: readonly string[]
  baseUrl?: string
  signal?: AbortSignal
  fetch?: Fetch
  /**
   * Fewer, longer requests for a caller that wants the text and not the turns: a recording of up to ten minutes in
   * one request, a longer one in pieces of up to ten minutes joined across pauses. Each piece then spans the silence
   * between its utterances, so two channels heard this way do not merge into a dialogue.
   */
  bundle?: boolean
  /** The voice detector model; the shared models directory's when not given. */
  vadModel?: string
  env?: NodeJS.ProcessEnv
  /** Seams for tests: the detector, the retry policy and the clock. */
  cutter?: (vadModel: string) => SpeechCutter
  retry?: RetryConfig
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

const RETRY: RetryConfig = { ...DEFAULT_RETRY, retries: 4 }

const interrupted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return
  if (signal.reason instanceof CliError) throw signal.reason
  const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
  throw new CliError(timeout ? "timeout" : "cancelled", "the transcription was interrupted")
}

const sleeping = (ms: number, signal?: AbortSignal): Promise<void> =>
  wait(ms, undefined, signal ? { signal } : {}).then(
    () => undefined,
    (error: unknown) => {
      interrupted(signal)
      throw error
    },
  )

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

const safe = (value: unknown): string | undefined =>
  typeof value === "string" && /^[\w.-]{1,64}$/.test(value) ? value : undefined

/** OpenAI's error code and type, never its message: a message can quote the request. */
const failureOf = async (response: Response): Promise<{ code?: string; type?: string }> => {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; type?: unknown } }
    const code = safe(body.error?.code)
    const type = safe(body.error?.type)
    return { ...(code ? { code } : {}), ...(type ? { type } : {}) }
  } catch {
    return {}
  }
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
      const body = (await response.json().catch(() => interrupted(options.signal))) as { text?: unknown } | undefined
      if (typeof body?.text !== "string")
        throw new CliError("invalid_response", "OpenAI answered without a transcript", {
          reason: "provider.invalid-response",
        })
      return body.text.trim()
    }
    const { code, type } = await failureOf(response)
    const status = response.status
    const said = `HTTP ${status}${code ? `, ${code}` : type ? `, ${type}` : ""}`
    if (status === 401)
      throw new CliError(
        "authentication_error",
        `OpenAI refused the key (${said}) — set it again with \`models keys set openai\``,
        { reason: "auth.failed" },
      )
    if (status === 403)
      throw new CliError(
        "permission_error",
        `OpenAI refused the request (${said}) — it answers this when the country or region is not supported, or the key's project may not use the model`,
        { reason: "access.denied" },
      )
    if (status === 413)
      throw new CliError("validation_error", `OpenAI refused the audio as too large (${said})`, {
        reason: "transcription.too-large",
      })
    if (EXHAUSTED.has(code ?? "") || EXHAUSTED.has(type ?? ""))
      throw new CliError(
        "permission_error",
        `OpenAI refused: the account's credit, spend limit or usage limit is used up (${said}) — see the billing page`,
        { reason: "transcription.quota-exhausted" },
      )
    const again = status === 408 || status === 429 || status >= 500
    const asked = providerWaitMs(response.headers, () => new Date())
    if (again && attempt <= retry.retries && (asked === undefined || asked <= retry.maxRetryAfterMs)) {
      await sleep(asked ?? backoffMs(attempt, retry, random), options.signal)
      continue
    }
    if (status === 429)
      throw new CliError("rate_limited", `OpenAI answered ${said}`, {
        reason: "provider.rate-limited",
        ...(asked === undefined ? {} : { retry_after_ms: asked }),
      })
    if (status >= 500)
      throw new CliError(
        [502, 503, 504].includes(status) ? "provider_unavailable" : "provider_error",
        `OpenAI answered ${said}`,
        { reason: [502, 503, 504].includes(status) ? "provider.unavailable" : "provider.refused" },
      )
    throw new CliError("provider_error", `OpenAI answered ${said}`, { reason: "provider.refused" })
  }
}

/**
 * Each stretch of speech the detector found is a piece of its own: on one channel of a call, a pause is often the
 * other person talking. Two stretches the detector split without a pause stay one. With `limit`, neighbours are also
 * joined across pauses while the piece stays within it.
 */
export const piecesOf = (spans: readonly { start: number; end: number }[], limit?: number) => {
  const pieces: { start: number; end: number }[] = []
  for (const span of spans) {
    const last = pieces.at(-1)
    const joined = last !== undefined && span.start - last.end < JOINED_SECONDS
    const fits = last !== undefined && limit !== undefined && span.end - last.start <= limit
    if (last && (fits || (joined && span.end - last.start <= LONGEST_REQUEST_SECONDS))) last.end = span.end
    else pieces.push({ start: span.start, end: span.end })
  }
  return pieces
}

const openCutter = async (vadModel: string): Promise<SpeechCutter> => {
  const { openSpeechCutter } = await import("./recognize.js")
  return openSpeechCutter(vadModel)
}

const checkKeywords = (keywords: readonly string[] = []): void => {
  const bad = keywords.find((keyword) => typeof keyword !== "string" || !keyword.trim() || /[<>\r\n]/.test(keyword))
  if (bad !== undefined)
    throw new CliError(
      "validation_error",
      "a keyword must be a non-empty single line without < or > — OpenAI refuses the whole request otherwise",
    )
}

/**
 * Speech to text by OpenAI's `/audio/transcriptions`, from one channel's samples: one piece per stretch of speech the
 * voice detector found, each sent alone, with where it lies in seconds. Two channels heard this way merge into a
 * dialogue by `start`. `gpt-transcribe` gives no timestamps of its own, so the times are the detector's.
 */
export const transcribeOpenAI = async (audio: Pcm, options: OpenAITranscription): Promise<TimedText[]> => {
  if (!options.apiKey)
    throw new CliError("authentication_error", "no OpenAI key — `models keys set openai`, or OPENAI_API_KEY", {
      reason: "transcription.no-key",
    })
  checkKeywords(options.keywords)
  interrupted(options.signal)
  const pcm = toModelRate(audio.samples, audio.rate)
  const duration = (pcm.length - LEAD) / SAMPLE_RATE
  if (options.bundle && duration <= LONGEST_REQUEST_SECONDS) {
    const text = await send(encodeWav(pcm.subarray(LEAD)), options)
    return text ? [{ start: 0, end: duration, text }] : []
  }
  const vadModel = options.vadModel ?? vadPath(modelsDirectory(options.env))
  if (!options.cutter && !filesPresent([[VAD, vadModel]]))
    throw new CliError(
      "not_found",
      "the voice detector that finds the speech is not on this machine — it comes with any speech model: `models download`",
      { reason: "model.not-downloaded", model: "silero_vad" },
    )
  const cutter = await (options.cutter ?? openCutter)(vadModel)
  let spans: { start: number; end: number }[]
  try {
    spans = cutter.cut(pcm)
  } finally {
    cutter.free()
  }
  const pieces = piecesOf(spans, options.bundle ? LONGEST_REQUEST_SECONDS : undefined)
  const heard: TimedText[] = []
  for (const [index, piece] of pieces.entries()) {
    const end = Math.min(piece.end, duration)
    const from = Math.max(piece.start - PAD_SECONDS, pieces[index - 1]?.end ?? 0)
    const to = Math.min(end + PAD_SECONDS, pieces[index + 1]?.start ?? duration)
    const samples = pcm.subarray(LEAD + Math.floor(from * SAMPLE_RATE), LEAD + Math.ceil(to * SAMPLE_RATE))
    const text = await send(encodeWav(samples), options)
    if (text) heard.push({ start: Math.min(piece.start, end), end, text })
  }
  return heard
}
