import { CliError } from "@wirecat/cli-base"
import type { MeetingReadBudget } from "./read-store.js"

export interface MeetingParticipantSearchOptions extends MeetingReadBudget {
  accountId: number
  limit?: number
  scanLimit?: number
  cursor?: string
}

export interface MeetingParticipantCandidate {
  participant_id: number
  meeting_id: number
  identity_id: number
  display_name: string | null
  email: string | null
}

export interface MeetingParticipantPage {
  schema_version: 1
  kind: "meeting_participants"
  account_id: number
  query: string
  items: MeetingParticipantCandidate[]
  limit: number
  has_more: boolean
  next_cursor: string | null
  /** Page-local identities are observations, never speaker attribution or person links. */
  ambiguity: { scope: "page"; multiple_identities: boolean; identity_ids: number[] }
  coverage: {
    scanned: number
    read_bytes: number
    archive_completeness: "unknown"
    truncated_by: "limit" | "scan_limit" | "read_bytes" | null
  }
}

export interface MeetingParticipantSearchStore {
  participantCandidates(query: string, input: MeetingParticipantSearchOptions): Promise<MeetingParticipantPage>
}

export type MeetingParticipantReader = (
  query: string,
  options: Omit<MeetingParticipantSearchOptions, "accountId">,
) => Promise<MeetingParticipantPage>

export const normalizeMeetingParticipantQuery = (text: string): string => text.normalize("NFKC").toLowerCase()

export const validateMeetingParticipantQuery = (query: string): string => {
  if (typeof query !== "string" || !query.trim() || query.length > 500 || query.includes("\0"))
    throw new CliError("validation_error", "participant query must contain 1–500 characters without NUL")
  return normalizeMeetingParticipantQuery(query.trim())
}

export const validateMeetingParticipantSearch = (query: string, input: MeetingParticipantSearchOptions) => {
  input.signal?.throwIfAborted()
  const normalized = validateMeetingParticipantQuery(query)
  const bounded = (value: number, maximum: number, name: string) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new CliError("validation_error", `${name} must be an integer from 1 through ${maximum}`)
    return value
  }
  return {
    query: normalized,
    accountId: bounded(input.accountId, Number.MAX_SAFE_INTEGER, "accountId"),
    limit: bounded(input.limit ?? 50, 1000, "limit"),
    scanLimit: bounded(input.scanLimit ?? 1000, 10000, "scanLimit"),
    maxReadBytes: bounded(input.maxReadBytes ?? 1024 ** 2, 64 * 1024 ** 2, "maxReadBytes"),
  }
}
