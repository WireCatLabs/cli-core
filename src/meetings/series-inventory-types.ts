import type { MeetingProviderScope } from "./provider.js"

/** A discovery hint, never a verified next occurrence or evidence permalink. */
export interface MeetingSeriesCandidate {
  meetingId: string
  title: string | null
  kind: "single" | "recurring" | "unscheduled" | "unknown"
  scheduledStartAt: number | null
}

export interface MeetingSeriesInventoryRequest {
  after: number
  until: number
  limit?: number
  maxReadBytes?: number
  bytes?: number
  cursor?: string
  signal?: AbortSignal
}

export interface MeetingSeriesInventoryRead {
  readonly scope: Readonly<MeetingProviderScope>
  readonly after: number
  readonly until: number
  readonly limit: number
  readonly maxReadBytes: number
  readonly cursor?: string
  readonly signal?: AbortSignal
}

export interface MeetingSeriesInventoryPage {
  scope: MeetingProviderScope
  after: number
  until: number
  items: readonly MeetingSeriesCandidate[]
  nextCursor: string | null
  coverage: { selection: "provider-window" | "provider-inventory"; partial: boolean }
}

/** One bounded provider page; implementations must not materialize an entire calendar and slice. */
export interface MeetingSeriesInventoryPort {
  read(context: MeetingSeriesInventoryRead): Promise<MeetingSeriesInventoryPage>
}

export interface MeetingSeriesInventoryResult {
  schemaVersion: 1
  kind: "meeting_series_inventory"
  scope: Readonly<MeetingProviderScope>
  after: number
  until: number
  items: MeetingSeriesCandidate[]
  nextCursor: string | null
  fingerprint: string
  limits: { limit: number; maxReadBytes: number; bytes: number }
  coverage: {
    selection: "provider-window" | "provider-inventory"
    sourcePartial: boolean
    hasMore: boolean
    undated: number
    dateHintsOutsideWindow: number
    calendarCompleteness: "unknown"
    occurrenceProof: "not-read"
    consistency: "live-provider-pages"
  }
}
