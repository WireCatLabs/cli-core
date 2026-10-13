import { CliError } from "@wirecat/cli-base"

export interface MeetingHitContextOptions {
  before?: number
  after?: number
  bytes?: number
  max_read_bytes?: number
  expected_fingerprint?: string
  signal?: AbortSignal
}
export interface MeetingContextCue {
  ref: string
  fingerprint: string
  transcript_id: number
  content_hash: string | null
  position: number
  start_ms: number
  end_ms: number
  speaker_participant_id: number | null
  speaker_name: string | null
  text: string
  revision: "current" | "superseded"
}
export const meetingHitContextLimits = (options: MeetingHitContextOptions = {}) => {
  const { before = 3, after = 3, bytes = 65536, max_read_bytes = 4194304, expected_fingerprint } = options
  if (
    ![before, after].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    before + after > 999 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 2 ||
    bytes > 4194304 ||
    !Number.isSafeInteger(max_read_bytes) ||
    max_read_bytes < 1 ||
    max_read_bytes > 67108864 ||
    (expected_fingerprint !== undefined &&
      (typeof expected_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(expected_fingerprint)))
  )
    throw new CliError(
      "validation_error",
      "context takes 0–999 surrounding cues, 2–4194304 output bytes and a bounded read budget",
    )
  return { before, after, bytes, max_read_bytes }
}

export interface MeetingHitContextPacket {
  schema_version: 1
  kind: "meeting_context"
  source: string
  target_ref: string
  target_fingerprint: string
  fingerprint: string
  revision: "current" | "superseded"
  limits: { before: number; after: number; bytes: number; max_read_bytes: number }
  content_bytes: number
  coverage: {
    included: number
    before: number
    after: number
    has_before: boolean
    has_after: boolean
    truncated_by: "bytes" | null
    before_ref: string | null
    after_ref: string | null
    continuation: "anchor-inclusive"
    archive_completeness: "unknown"
    input: "bounded-meeting-context"
  }
  items: MeetingContextCue[]
}
export type MeetingPassageOutputFormat = "json" | "text" | "markdown"
export interface MeetingPassageRequest extends MeetingHitContextOptions {
  format?: MeetingPassageOutputFormat
}
export interface MeetingPassageResult {
  packet: MeetingHitContextPacket
  content: string
}
export type MeetingPassageReader = (reference: string, options: MeetingPassageRequest) => Promise<MeetingPassageResult>
export const validateMeetingPassage = (reference: string, options: MeetingPassageRequest) => {
  meetingHitContextLimits(options)
  if (
    typeof reference !== "string" ||
    !reference.trim() ||
    reference.length > 200 ||
    (options.format !== undefined && !["json", "text", "markdown"].includes(options.format))
  )
    throw new CliError("validation_error", "choose a cue reference and json, text or markdown output")
}
