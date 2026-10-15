import { CliError } from "@wirecat/cli-base"
import {
  canonicalMeetingReference,
  type MeetingPassageRequest,
  type MeetingPassageResult,
  validateMeetingPassage,
} from "../meetings/index.js"
import type { MeetingEvidencePacket } from "./meeting-evidence.js"
import { type MeetingHitContextPacket, readMeetingHitContext } from "./meeting-hit-context.js"

export type MeetingPassageFormat = "text" | "markdown"
const visible = (text: string) =>
  text.replace(/[\p{Cc}\p{Cf}]/gu, (value) =>
    value === "\n" || value === "\t" ? value : `\\u{${value.codePointAt(0)?.toString(16)}}`,
  )
const markdown = (text: string) =>
  visible(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_[\]#|~]/g, "\\$&")
const timestamp = (ms: number) => {
  if (!Number.isSafeInteger(ms) || ms < 0)
    throw new CliError("invalid_response", "passage timestamps must be nonnegative safe integers")
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 3600)
    .toString()
    .padStart(
      2,
      "0",
    )}:${Math.floor(seconds / 60) % 60 < 10 ? "0" : ""}${Math.floor(seconds / 60) % 60}:${(seconds % 60).toString().padStart(2, "0")}`
}
/** Presentation only: retained references, revision flags and incomplete coverage survive compact output. */
export const formatMeetingPassage = (
  packet: MeetingEvidencePacket | MeetingHitContextPacket,
  format: MeetingPassageFormat = "text",
  maxBytes = 4194304,
): string => {
  if (
    (format !== "text" && format !== "markdown") ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 67108864
  )
    throw new CliError("validation_error", "choose text or markdown and a bounded passage output size")
  const ref = (value: string) => {
    const canonical = canonicalMeetingReference(value)
    return format === "markdown" ? `\`${canonical}\`` : canonical
  }
  const source = ref(packet.source)
  const context = packet.kind === "meeting_context"
  const coverage = context
    ? `Cues: ${packet.coverage.included}; before: ${packet.coverage.before}/${packet.limits.before}; after: ${packet.coverage.after}/${packet.limits.after}; more before: ${packet.coverage.has_before}; more after: ${packet.coverage.has_after}; clipped: ${packet.coverage.truncated_by ?? "none"}; archive: ${packet.coverage.archive_completeness}.`
    : `Cues: ${packet.coverage.included}; more: ${packet.coverage.hasMore}; clipped: ${packet.coverage.truncatedBy ?? "none"}; unavailable revisions: ${packet.coverage.skippedUnavailable}; archive: ${packet.coverage.archiveCompleteness}.`
  const lines = [`Source: ${source}`, coverage]
  if (context) {
    lines.push(`Target: ${ref(packet.target_ref)}; revision: ${packet.revision}.`)
    if (packet.coverage.before_ref) lines.push(`Before anchor (inclusive): ${ref(packet.coverage.before_ref)}`)
    if (packet.coverage.after_ref) lines.push(`After anchor (inclusive): ${ref(packet.coverage.after_ref)}`)
  } else {
    if (packet.coverage.nextReference) lines.push(`Continue after: ${ref(packet.coverage.nextReference)}`)
    if (packet.coverage.nextTranscriptId !== null)
      lines.push(`Continue after transcript: ${packet.coverage.nextTranscriptId}`)
  }
  if (!packet.items.length)
    lines.push("No cues included; check coverage and limits before concluding content is absent.")
  let bytes = Buffer.byteLength(lines.join("\n"), "utf8") + 1
  if (bytes > maxBytes) throw new CliError("validation_error", "compact passage exceeds its output byte budget")
  for (const item of packet.items) {
    const cue =
      "ref" in item
        ? {
            ref: item.ref,
            start: item.start_ms,
            end: item.end_ms,
            speaker: item.speaker_name,
            text: item.text,
            revision: item.revision,
          }
        : {
            ref: item.reference,
            start: item.startMs,
            end: item.endMs,
            speaker: item.speakerName,
            text: item.text,
            revision: item.revision,
          }
    const label = (cue.speaker ?? "Unknown speaker").replace(/[\r\n\t]/g, " ")
    const heading = `${timestamp(cue.start)}–${timestamp(cue.end)} | ${format === "markdown" ? markdown(label) : visible(label)} | ${ref(cue.ref)} | ${cue.revision}`
    const body =
      format === "markdown"
        ? markdown(cue.text)
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")
        : visible(cue.text)
    const part = `\n${heading}\n${body}`
    bytes += Buffer.byteLength(part, "utf8") + 1
    if (bytes > maxBytes) throw new CliError("validation_error", "compact passage exceeds its output byte budget")
    lines.push(part)
  }
  return `${lines.join("\n")}\n`
}

/** Shared orchestration for CLI and MCP hosts; the host supplies its authorized account/store. */
export const readMeetingPassage = async (
  store: Parameters<typeof readMeetingHitContext>[0],
  accountId: number,
  reference: string,
  options: MeetingPassageRequest = {},
): Promise<MeetingPassageResult> => {
  options = { ...options }
  validateMeetingPassage(reference, options)
  const packet = await readMeetingHitContext(store, accountId, reference, options)
  const content =
    options.format === undefined || options.format === "json"
      ? JSON.stringify(packet)
      : formatMeetingPassage(packet, options.format)
  options.signal?.throwIfAborted()
  return { packet, content }
}
