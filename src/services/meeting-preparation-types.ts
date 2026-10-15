import type {
  createUpcomingMeetingReader,
  MeetingHistoryEntry,
  MeetingPreparationContext,
  MeetingPreparationContextStore,
  MeetingPreparationFact,
  MeetingPreparationKnowledgeStore,
  MeetingReadCapabilities,
  MeetingRelatedHistoryEntry,
  MeetingRelatedHistoryStore,
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
    MeetingPreparationContextStore &
    MeetingRelatedHistoryStore &
    Partial<MeetingPreparationKnowledgeStore>
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
  related: {
    anchors: string[]
    items: (MeetingRelatedHistoryEntry & { reference: string; evidence: MeetingEvidencePacket })[]
    hasMore: boolean
    outputLimited: boolean
    selection: "explicit-person-links/confirmed-project-links"
  }
  knowledge?: {
    anchors: string[]
    items: MeetingPreparationFact[]
    hasMore: boolean
    outputLimited: boolean
    selection: "accepted-global-person/project-facts"
    factEvidence: "not-revalidated"
    otherSources: "not-queried"
  }
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
    unqueried: readonly (
      | "person-history"
      | "project-wide-context"
      | "person-nonmeeting-context"
      | "project-nonmeeting-context"
      | "project-alias-candidates"
    )[]
  }
}
