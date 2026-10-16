import { createHash } from "node:crypto"

export interface MeetingCueIdentity {
  reference: string
  transcriptId: number
  contentHash: string | null
  position: number
  startMs: number
  endMs: number
  speakerParticipantId: number | null
  speakerName: string | null
  text: string
}

export const meetingCueFingerprint = (cue: MeetingCueIdentity): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        reference: cue.reference,
        transcriptId: cue.transcriptId,
        contentHash: cue.contentHash,
        position: cue.position,
        startMs: cue.startMs,
        endMs: cue.endMs,
        speakerParticipantId: cue.speakerParticipantId,
        speakerName: cue.speakerName,
        text: cue.text,
      }),
    )
    .digest("hex")
