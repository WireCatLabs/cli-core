import type { MeetingProjectCandidates, MeetingStore } from "../meetings/index.js"
import type { VocabularyStore } from "../store/index.js"
import type { MeetingEvidencePacket } from "./meeting-evidence.js"
import type { MeetingReadStore } from "./meeting-reference.js"

export interface StoredMeetingProjectCandidateOptions {
  limit?: number
  cues?: number
  bytes?: number
  maxReadBytes?: number
  after?: string
  afterTranscriptId?: number
  signal?: AbortSignal
}

export interface StoredMeetingProjectCandidates extends MeetingProjectCandidates {
  evidence: {
    fingerprint: string
    limits: MeetingEvidencePacket["limits"]
    coverage: MeetingEvidencePacket["coverage"]
    consistency: "live-reads"
    maxStoreCalls: 8
  }
}

export type StoredMeetingProjectCandidateReader = (
  reference: string,
  options?: StoredMeetingProjectCandidateOptions,
) => Promise<StoredMeetingProjectCandidates>

export interface StoredMeetingProjectCandidatePorts {
  meetings: MeetingReadStore & Pick<MeetingStore, "account">
  vocabulary: Pick<VocabularyStore, "vocabulary">
}
