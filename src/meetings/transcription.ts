import { CliError } from "@wirecat/cli-base"
import { contentHash } from "./ingest.js"
import { dispatchMeetingMutation, type MeetingMutationOptions } from "./meeting-management.js"
import type {
  MeetingTranscriptReceiptStore,
  TranscriptAppendReceipt,
  UnlinkedTranscriptInput,
} from "./transcript-store.js"

export interface MeetingMediaDescriptor {
  id: string
  contentHash: string
  size: number
  durationMs: number
  format: string
  sampleRate: number
  channels: number
  recognition: { engine: string; model: string; version?: string; timing?: "fixed-windows" | "recognition-segments" }
}

export interface MeetingRecognitionSegment {
  startMs: number
  endMs: number
  text: string
  /** Who spoke, when the source knows — a channel of a two-channel call. Speakers may overlap; one speaker may not. */
  speaker?: string
}

export interface MeetingTranscriptionContext {
  maxBytes: number
  maxDurationMs: number
  signal?: AbortSignal
}

/** Native hosts own media decoding and installed models; description must never install a model. */
export interface MeetingTranscriptionSource {
  describe(context: MeetingTranscriptionContext): Promise<MeetingMediaDescriptor>
  segments(
    media: Readonly<MeetingMediaDescriptor>,
    context: MeetingTranscriptionContext,
  ): AsyncIterable<MeetingRecognitionSegment>
}

export interface MeetingTranscriptionOptions extends MeetingMutationOptions {
  maxBytes?: number
  maxDurationMs?: number
  maxSegments?: number
  maxTextBytes?: number
}

export interface MeetingTranscriptionReceipt {
  media: Readonly<MeetingMediaDescriptor>
  accountId: number
  externalId: string
  applied: boolean
  segments: number
  append?: TranscriptAppendReceipt
}

const bounded = (value: number, max: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new CliError("validation_error", `${name} must be an integer from 1 to ${max}`)
  return value
}
const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 1000 || /[\0\r\n]/.test(value))
    throw new CliError("validation_error", "transcription identifiers must be bounded nonempty strings")
  return value
}
/** Recognized off this machine: the stored source names the provider rather than `local/`. */
const REMOTE_ENGINES = new Set(["openai"])

const cancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    if (signal.reason instanceof CliError) throw signal.reason
    const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
    throw new CliError(timeout ? "timeout" : "cancelled", "meeting transcription was interrupted")
  }
}

/** Preview describes the media; recognition and one atomic append require explicit apply. */
export const transcribeMeeting = async (
  source: MeetingTranscriptionSource,
  store: MeetingTranscriptReceiptStore,
  target: { accountId: number; externalId: string; now: number },
  options: MeetingTranscriptionOptions = {},
): Promise<MeetingTranscriptionReceipt> => {
  const accountId = bounded(target.accountId, Number.MAX_SAFE_INTEGER, "account ID")
  const externalId = identifier(target.externalId)
  const now = target.now
  const mutation = { apply: options.apply, dryRun: options.dryRun, signal: options.signal }
  if (!Number.isSafeInteger(now) || now < 0) throw new CliError("validation_error", "invalid transcription timestamp")
  const context = Object.freeze({
    maxBytes: bounded(options.maxBytes ?? 1024 ** 3, 4 * 1024 ** 3, "media byte limit"),
    maxDurationMs: bounded(options.maxDurationMs ?? 4 * 3600_000, 24 * 3600_000, "media duration limit"),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const maxSegments = bounded(options.maxSegments ?? 10_000, 100_000, "segment limit")
  const maxTextBytes = bounded(options.maxTextBytes ?? 4 * 1024 ** 2, 64 * 1024 ** 2, "transcript byte limit")
  cancelled(context.signal)
  const raw = await source.describe(context)
  cancelled(context.signal)
  const recognition = raw.recognition
  const engine = recognition.engine
  const model = recognition.model
  const version = recognition.version
  const timing = recognition.timing ?? "recognition-segments"
  if (timing !== "fixed-windows" && timing !== "recognition-segments")
    throw new CliError("invalid_response", "unsupported recognition timing")
  const media = Object.freeze({
    id: identifier(raw.id),
    contentHash: raw.contentHash,
    size: bounded(raw.size, context.maxBytes, "media size"),
    durationMs: bounded(raw.durationMs, context.maxDurationMs, "media duration"),
    format: identifier(raw.format),
    sampleRate: bounded(raw.sampleRate, 384_000, "sample rate"),
    channels: bounded(raw.channels, 32, "channel count"),
    recognition: Object.freeze({
      engine: identifier(engine),
      model: identifier(model),
      ...(version === undefined ? {} : { version: identifier(version) }),
      timing,
    }),
  })
  if (!/^[a-f0-9]{64}$/.test(media.contentHash))
    throw new CliError("invalid_response", "media needs a SHA-256 content hash")
  const outcome = await dispatchMeetingMutation(mutation, async () => {
    const rows: UnlinkedTranscriptInput["rows"] = []
    let textBytes = 0
    let start = 0
    const ends = new Map<string | undefined, number>()
    let provided = 0
    for await (const segment of source.segments(media, context)) {
      cancelled(context.signal)
      provided++
      const speaker = segment.speaker
      if (
        speaker !== undefined &&
        (typeof speaker !== "string" || !speaker.trim() || speaker.length > 200 || /[\0\r\n]/.test(speaker))
      )
        throw new CliError("invalid_response", "invalid recognition segment speaker")
      // Without speakers, nothing may overlap; with them, only one speaker's own segments may not.
      const overlapping =
        speaker === undefined
          ? [...ends.values()].reduce((latest, end) => Math.max(latest, end), 0)
          : Math.max(ends.get(undefined) ?? 0, ends.get(speaker) ?? 0)
      if (
        provided > maxSegments ||
        !Number.isSafeInteger(segment.startMs) ||
        !Number.isSafeInteger(segment.endMs) ||
        segment.startMs < start ||
        segment.startMs < overlapping ||
        segment.endMs <= segment.startMs ||
        segment.endMs > media.durationMs ||
        typeof segment.text !== "string" ||
        segment.text.includes("\0")
      )
        throw new CliError("invalid_response", "invalid or excessive recognition segments")
      start = segment.startMs
      ends.set(speaker, Math.max(ends.get(speaker) ?? 0, segment.endMs))
      const text = segment.text.trim()
      if (text.length > maxTextBytes - textBytes)
        throw new CliError("validation_error", "transcript exceeds its byte limit")
      textBytes += new TextEncoder().encode(text).byteLength
      if (textBytes > maxTextBytes) throw new CliError("validation_error", "transcript exceeds its byte limit")
      if (text)
        rows.push({
          position: rows.length,
          startMs: segment.startMs,
          endMs: segment.endMs,
          speakerName: speaker ?? null,
          text,
          normalizedText: null,
          metadata: null,
        })
    }
    cancelled(context.signal)
    if (!rows.length) throw new CliError("not_found", "no speech was recognized")
    const provenance = {
      mediaSha256: media.contentHash,
      engine: media.recognition.engine,
      model: media.recognition.model,
      modelVersion: media.recognition.version ?? null,
      timing: media.recognition.timing,
    }
    const hash = await contentHash(JSON.stringify({ provenance, rows }))
    cancelled(context.signal)
    const append = await store.appendTranscriptsWithReceipt({
      accountId,
      externalId,
      now,
      transcripts: [
        {
          ...(REMOTE_ENGINES.has(media.recognition.engine)
            ? {
                source: `${encodeURIComponent(media.recognition.engine)}/${encodeURIComponent(media.recognition.model)}`,
                format: `${media.recognition.engine}-transcription`,
              }
            : {
                source: `local/${encodeURIComponent(media.recognition.engine)}/${encodeURIComponent(media.recognition.model)}`,
                format: "local-transcription",
              }),
          language: null,
          contentHash: hash,
          externalCreatedAt: null,
          metadata: provenance,
          deletedAt: null,
          rows,
        },
      ],
    })
    let valid = false
    try {
      const meeting = append?.meeting?.meeting
      valid =
        meeting?.accountId === accountId &&
        meeting.externalId === externalId &&
        meeting.deletedAt === null &&
        Number.isSafeInteger(meeting.id) &&
        meeting.id > 0 &&
        append.created === false &&
        [append.insertedTranscripts, append.replayedTranscripts, append.supersededTranscripts].every(
          (count) => Number.isSafeInteger(count) && count >= 0,
        ) &&
        append.insertedTranscripts + append.replayedTranscripts === 1
    } catch {
      valid = false
    }
    if (!valid)
      throw new CliError(
        "outcome_unknown",
        "transcription append acknowledgement is invalid; verify stored state before retrying",
      )
    return { append, segments: rows.length }
  })
  return {
    media,
    accountId,
    externalId,
    applied: outcome.applied,
    segments: outcome.value?.segments ?? 0,
    ...(outcome.value ? { append: outcome.value.append } : {}),
  }
}
