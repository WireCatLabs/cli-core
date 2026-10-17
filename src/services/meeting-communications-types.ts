import type {
  ContextEvidenceItem,
  ContextEvidencePage,
  ContextEvidenceReader,
  ContextSource,
} from "../context/evidence.js"
import type { ContextReadUsage } from "../context/read-budget.js"

export type { MeetingCommunicationsRequest } from "../context/communication-selection.js"

export interface MeetingCommunicationsPort {
  selections: readonly { id: string; source: ContextSource }[]
  reader: ContextEvidenceReader
}
export interface MeetingCommunicationExcerpt extends ContextEvidenceItem {
  selectionId: string
  textTruncated: boolean
}
export interface MeetingCommunicationCoverage {
  selectionId: string
  source: ContextSource
  state: "searched" | "unavailable" | "read-limited"
  index: ContextEvidencePage["coverage"]["index"]
  hasMore: boolean
  hasUndated: boolean
  completeness: "unknown"
  consistency: "snapshot-per-page"
  nextCursor: string | null
  restartRequired: boolean
  outputLimited: boolean
  readBytes: number | null
  issue: "not_found" | "validation_error" | "configuration_error" | null
}
export interface MeetingCommunications {
  readUsage: ContextReadUsage
  query: string
  window: { after: number; before: number }
  selection: "explicit-host-grants/literal-words"
  sources: MeetingCommunicationCoverage[]
  items: MeetingCommunicationExcerpt[]
}
