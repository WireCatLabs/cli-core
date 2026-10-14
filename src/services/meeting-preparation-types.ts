import type {
  createUpcomingMeetingReader,
  MeetingHistoryEntry,
  MeetingPreparationContext,
  MeetingPreparationContextStore,
  MeetingReadCapabilities,
  MeetingSeriesContext,
  MeetingSeriesHistoryStore,
  MeetingStore,
  UpcomingMeetingResult,
} from "../meetings/index.js"
import type { MeetingEvidencePacket } from "./meeting-evidence.js"

export interface MeetingPreparationRequest {
  after: number
  until: number
  historyAfter: number
  meetings?: number
  cues?: number
  contextLimit?: number
  maxReadBytes?: number
  bytes?: number
  signal?: AbortSignal
}
export interface MeetingPreparationPorts {
  meetings: Pick<MeetingStore, "account"> &
    MeetingReadCapabilities &
    MeetingSeriesHistoryStore &
    MeetingPreparationContextStore
  upcoming: ReturnType<typeof createUpcomingMeetingReader>
}
export interface MeetingPreparationEntry {
  reference: string
  meeting: MeetingHistoryEntry
  evidence: MeetingEvidencePacket
  context: MeetingPreparationContext
}
export interface MeetingPreparation {
  schemaVersion: 1
  accountId: number
  upcoming: UpcomingMeetingResult
  series: MeetingSeriesContext | null
  historyWindow: { after: number; before: number }
  items: MeetingPreparationEntry[]
  limits: { meetings: number; cues: number; contextLimit: number; maxReadBytes: number; bytes: number }
  coverage: {
    archiveCompleteness: "unknown"
    consistency: "live-reads"
    historyHasMore: boolean
    hasUndated: boolean
    skippedUnavailable: string[]
    outputLimited: boolean
    context: "observed-participants/confirmed-projects/accepted-meeting-subject-facts/direct-source-tasks"
    factEvidence: "not-revalidated"
    unqueried: readonly ["person-history", "project-wide-context", "project-alias-candidates"]
  }
}
