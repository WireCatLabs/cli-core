import type {
  createUpcomingMeetingReader,
  MeetingHistoryEntry,
  MeetingPreparationContext,
  MeetingPreparationContextStore,
  MeetingPreparationFact,
  MeetingPreparationKnowledgeStore,
  MeetingPreparationNote,
  MeetingPreparationNotesSelection,
  MeetingPreparationNotesStore,
  MeetingProjectDiscoveryPage,
  MeetingReadCapabilities,
  MeetingRelatedHistoryEntry,
  MeetingRelatedHistoryStore,
  MeetingSeriesContext,
  MeetingSeriesHistoryStore,
  MeetingStore,
  UpcomingMeetingResult,
} from "../meetings/index.js"
import type {
  MeetingCommunications,
  MeetingCommunicationsPort,
  MeetingCommunicationsRequest,
} from "./meeting-communications-types.js"
import type { MeetingEvidencePacket } from "./meeting-evidence.js"
import type { readMeetingProjectDiscovery } from "./meeting-project-discovery.js"

export interface MeetingPreparationRequest {
  communications?: MeetingCommunicationsRequest
  project?: string
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
  communications?: MeetingCommunicationsPort
  meetings: Pick<MeetingStore, "account"> &
    MeetingReadCapabilities &
    MeetingSeriesHistoryStore &
    MeetingPreparationContextStore &
    MeetingRelatedHistoryStore &
    Partial<MeetingPreparationKnowledgeStore & MeetingPreparationNotesStore>
  projectDiscovery?: Parameters<typeof readMeetingProjectDiscovery>[0]
  upcoming: ReturnType<typeof createUpcomingMeetingReader>
}
export interface MeetingPreparationEntry {
  reference: string
  meeting: MeetingHistoryEntry
  evidence: MeetingEvidencePacket
  context: MeetingPreparationContext
}
export interface MeetingPreparation {
  communications?: MeetingCommunications
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
    selection: "accepted-global-person/project-facts"
    coverage: {
      hasMore: boolean
      outputLimited: boolean
      factEvidence: "not-revalidated"
      otherSources: "not-queried" | "see-communications"
    }
  }
  notes?: {
    anchors: string[]
    items: MeetingPreparationNote[]
    selection: MeetingPreparationNotesSelection
    coverage: {
      hasMore: boolean
      outputLimited: boolean
      sourceEvidence: "not-revalidated"
      otherSources: "not-queried" | "see-communications"
    }
  }
  projectEvidence?: {
    project: string
    query: string
    pages: MeetingProjectDiscoveryPage[]
    coverage: { pageLimit: number; hasMore: boolean; outputLimited: boolean }
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
      | "other-person-nonmeeting-context"
      | "other-project-nonmeeting-context"
      | "project-alias-candidates"
    )[]
  }
}
