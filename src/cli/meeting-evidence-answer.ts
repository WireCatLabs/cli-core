import type { MeetingEvidenceCue, MeetingEvidencePacket, PersonMeetingContext } from "../services/index.js"
import { snakeKeys } from "./envelope.js"

const id = (value: number | null) => (value === null ? null : String(value))

const mapCue = ({ reference, startMs, ...cue }: MeetingEvidenceCue) => ({
  ...cue,
  ref: reference,
  offsetMs: startMs,
  transcriptId: id(cue.transcriptId),
  speakerParticipantId: id(cue.speakerParticipantId),
})

/** A meeting evidence packet with `ref`, `offset_ms` and string ids, as every answer that carries one names them. */
export const mapEvidence = (evidence: MeetingEvidencePacket) => ({
  ...evidence,
  coverage: { ...evidence.coverage, nextTranscriptId: id(evidence.coverage.nextTranscriptId) },
  items: evidence.items.map(mapCue),
})

/** `meetings evidence`: the `meeting_evidence` entity. */
export const meetingEvidenceItem = (evidence: MeetingEvidencePacket) => snakeKeys(mapEvidence(evidence))

/** `meetings context`: the `meeting_person_context` entity. */
export const meetingPersonContextItem = (context: PersonMeetingContext) =>
  snakeKeys({
    ...context,
    items: context.items.map(({ reference, cues, ...item }) => ({ ...item, ref: reference, cues: cues.map(mapCue) })),
  })
