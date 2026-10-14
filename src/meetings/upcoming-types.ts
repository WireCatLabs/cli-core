import type { MeetingProviderScope } from "./provider.js"

export interface MeetingOccurrence {
  id: string | null
  startAt: number | null
  endAt: number | null
  status: "scheduled" | "cancelled"
  verified: boolean
}

export interface MeetingOccurrenceSchedule {
  meetingId: string
  kind: "single" | "recurring" | "unscheduled" | "unknown"
  timezone: string | null
  occurrences: readonly MeetingOccurrence[]
  complete: boolean
  missing: readonly ("schedule-details" | "occurrence-details")[]
}

export interface UpcomingMeetingRequest {
  after: number
  until: number
  limit?: number
  maxReadBytes?: number
  signal?: AbortSignal
}

export interface MeetingOccurrenceRead {
  readonly scope: Readonly<MeetingProviderScope>
  readonly after: number
  readonly until: number
  readonly limit: number
  readonly maxReadBytes: number
  readonly signal?: AbortSignal
}

/** Completeness covers this series and requested window, never the owner's entire calendar. */
export interface MeetingOccurrencePort {
  read(meetingId: string, context: MeetingOccurrenceRead): Promise<MeetingOccurrenceSchedule>
}

export interface UpcomingMeetingResult {
  scope: Readonly<MeetingProviderScope>
  meetingId: string
  kind: MeetingOccurrenceSchedule["kind"]
  after: number
  until: number
  timezone: string | null
  candidate: MeetingOccurrence | null
  verifiedNext: boolean
  coverage: {
    scheduleComplete: boolean
    inspected: number
    undated: number
    unverified: number
    cancelled: number
    simultaneous: number
    missing: readonly ("schedule-details" | "occurrence-details")[]
  }
}
