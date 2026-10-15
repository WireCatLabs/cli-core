import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import {
  formatMeetingReference,
  type MeetingContextCue,
  type MeetingHitContextOptions,
  type MeetingHitContextPacket,
  meetingHitContextLimits,
  parseMeetingReference,
} from "../meetings/index.js"
import type { MeetingContextReadCapabilities } from "../store/store.js"
import { checkMeetingCancelled, cueEvidence, type MeetingEvidenceCue } from "./meeting-evidence.js"

export {
  type MeetingContextCue,
  type MeetingHitContextOptions,
  type MeetingHitContextPacket,
  meetingHitContextLimits,
} from "../meetings/index.js"

const contextCue = (cue: MeetingEvidenceCue): MeetingContextCue => ({
  ref: cue.reference,
  fingerprint: cue.fingerprint,
  transcript_id: cue.transcriptId,
  content_hash: cue.contentHash,
  position: cue.position,
  start_ms: cue.startMs,
  end_ms: cue.endMs,
  speaker_participant_id: cue.speakerParticipantId,
  speaker_name: cue.speakerName,
  text: cue.text,
  revision: cue.revision,
})
/** One atomic adapter read binds the anchor and both sides to the same retained revision. */
export const readMeetingHitContext = async (
  store: Partial<MeetingContextReadCapabilities>,
  accountId: number,
  reference: string,
  options: MeetingHitContextOptions = {},
): Promise<MeetingHitContextPacket> => {
  const { signal, expected_fingerprint } = options
  const limits = meetingHitContextLimits(options)
  checkMeetingCancelled(signal)
  const parsed = parseMeetingReference(reference)
  if (!Number.isSafeInteger(accountId) || accountId < 1)
    throw new CliError("validation_error", "choose a positive meeting account")
  if (parsed.accountId !== accountId) throw new CliError("not_found", "meeting context is unavailable for this account")
  if (parsed.transcriptId === undefined || parsed.cuePosition === undefined)
    throw new CliError("validation_error", "context requires a transcript cue reference from a search hit")
  if (typeof store.transcriptContext !== "function")
    throw new CliError("configuration_error", "the store does not support bounded cue context")
  const page = await store.transcriptContext({
    accountId,
    meetingId: parsed.meetingId,
    transcriptId: parsed.transcriptId,
    position: parsed.cuePosition,
    before: limits.before,
    after: limits.after,
    maxReadBytes: limits.max_read_bytes,
    includeHistorical: true,
    signal: signal,
  })
  checkMeetingCancelled(signal)
  if (
    !page?.meeting ||
    !page.transcript ||
    page.meeting.id !== parsed.meetingId ||
    page.meeting.accountId !== accountId ||
    page.meeting.deletedAt !== null ||
    page.transcript.id !== parsed.transcriptId ||
    page.transcript.meetingId !== parsed.meetingId ||
    page.transcript.deletedAt !== null ||
    typeof page.hasBefore !== "boolean" ||
    typeof page.hasAfter !== "boolean" ||
    !Array.isArray(page.rows) ||
    page.rows.length > limits.before + limits.after + 1
  )
    throw new CliError("invalid_response", "context adapter returned inconsistent scope or bounds")
  let previous = -1
  const all = page.rows.map((row) => {
    if (
      !row ||
      typeof row.text !== "string" ||
      !Number.isSafeInteger(row.startMs) ||
      row.startMs < 0 ||
      !Number.isSafeInteger(row.endMs) ||
      row.endMs < row.startMs ||
      (row.speakerName !== null && typeof row.speakerName !== "string") ||
      row.meetingTranscriptId !== parsed.transcriptId ||
      !Number.isSafeInteger(row.position) ||
      row.position <= previous
    )
      throw new CliError("invalid_response", "context adapter returned inconsistent cue ordering")
    previous = row.position
    return contextCue(cueEvidence(accountId, parsed.meetingId, page.transcript, row))
  })
  const target = all.find((cue) => cue.position === parsed.cuePosition)
  if (!target) throw new CliError("not_found", "the context anchor is unavailable")
  if (expected_fingerprint !== undefined && target.fingerprint !== expected_fingerprint)
    throw new CliError("validation_error", "the context anchor changed since it was read", {
      reason: "stale_meeting_cue",
    })
  const left = all.filter((cue) => cue.position < target.position)
  const right = all.filter((cue) => cue.position > target.position)
  if (left.length > limits.before || right.length > limits.after)
    throw new CliError("invalid_response", "context adapter exceeded requested sides")
  const size = (cue: MeetingContextCue) => Buffer.byteLength(JSON.stringify(cue), "utf8")
  let content_bytes = size(target) + 2
  if (content_bytes > limits.bytes) throw new CliError("validation_error", "anchor cue exceeds the output byte budget")
  const picked = [target]
  let before = 0,
    after = 0,
    blockedBefore = false,
    blockedAfter = false
  for (let i = 1; i <= Math.max(left.length, right.length); i++) {
    checkMeetingCancelled(signal)
    for (const side of ["before", "after"] as const) {
      const cue = side === "before" ? left[left.length - i] : right[i - 1]
      if (!cue || (side === "before" ? blockedBefore : blockedAfter)) continue
      const bytes = size(cue) + 1
      if (content_bytes + bytes > limits.bytes) {
        if (side === "before") blockedBefore = true
        else blockedAfter = true
        continue
      }
      picked.push(cue)
      content_bytes += bytes
      if (side === "before") before++
      else after++
    }
  }
  picked.sort((a, b) => a.position - b.position)
  const has_before = page.hasBefore || before < left.length
  const has_after = page.hasAfter || after < right.length
  const packet = {
    schema_version: 1 as const,
    kind: "meeting_context" as const,
    source: formatMeetingReference(parsed),
    target_ref: target.ref,
    target_fingerprint: target.fingerprint,
    revision: target.revision,
    limits,
    content_bytes,
    coverage: {
      included: picked.length,
      before,
      after,
      has_before,
      has_after,
      truncated_by: blockedBefore || blockedAfter ? ("bytes" as const) : null,
      before_ref: has_before ? (picked[0]?.ref ?? null) : null,
      after_ref: has_after ? (picked.at(-1)?.ref ?? null) : null,
      continuation: "anchor-inclusive" as const,
      archive_completeness: "unknown" as const,
      input: "bounded-meeting-context" as const,
    },
    items: picked,
  }
  return { ...packet, fingerprint: createHash("sha256").update(JSON.stringify(packet)).digest("hex") }
}
