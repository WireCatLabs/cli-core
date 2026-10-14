import { CliError } from "@wirecat/cli-base"
import type { Meeting, MeetingSeries } from "./model.js"

export interface MeetingSeriesHistoryRequest {
  accountId: number
  externalId: string
  after: number
  before: number
  limit?: number
  maxReadBytes?: number
  signal?: AbortSignal
}
export type MeetingSeriesContext = Pick<MeetingSeries, "id" | "externalId" | "title" | "eventSeriesId" | "updatedAt">
export type MeetingHistoryEntry = Pick<
  Meeting,
  "id" | "externalId" | "title" | "eventId" | "startedAt" | "endedAt" | "updatedAt"
>
export interface MeetingSeriesHistory {
  series: MeetingSeriesContext | null
  items: MeetingHistoryEntry[]
  hasMore: boolean
  /** Undated retained occurrences cannot be assigned to the requested window. */
  hasUndated: boolean
}
export interface MeetingSeriesHistoryStore {
  /** Exact account/series key; bounded newest-first metadata in [after, before). */
  seriesHistory(input: MeetingSeriesHistoryRequest): Promise<MeetingSeriesHistory>
}

export const validateMeetingSeriesHistory = (input: MeetingSeriesHistoryRequest) => {
  input.signal?.throwIfAborted()
  if (!Number.isSafeInteger(input.accountId) || input.accountId <= 0)
    throw new CliError("validation_error", "accountId must be a positive safe integer")
  if (
    typeof input.externalId !== "string" ||
    !input.externalId.trim() ||
    new TextEncoder().encode(input.externalId).length > 4096 ||
    /[\0\r\n]/.test(input.externalId)
  )
    throw new CliError("validation_error", "externalId must be a bounded nonempty series identifier")
  for (const name of ["after", "before"] as const)
    if (!Number.isSafeInteger(input[name]) || Math.abs(input[name]) > 8640000000000000)
      throw new CliError("validation_error", `${name} must be an absolute timestamp in milliseconds`)
  if (input.after >= input.before) throw new CliError("validation_error", "after must be earlier than before")
  const limit = input.limit === undefined ? 20 : input.limit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new CliError("validation_error", "limit must be an integer from 1 to 100")
  const maxReadBytes = input.maxReadBytes === undefined ? 256 * 1024 : input.maxReadBytes
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > 4 * 1024 * 1024)
    throw new CliError("validation_error", "maxReadBytes must be an integer from 1 to 4194304")
  return { ...input, limit, maxReadBytes }
}
