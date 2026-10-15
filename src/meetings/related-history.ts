import { CliError } from "@wirecat/cli-base"
import type { MeetingHistoryEntry } from "./series-history.js"

export interface MeetingRelatedHistoryRequest {
  accountId: number
  seriesId: number
  anchorIds: readonly number[]
  after: number
  before: number
  limit?: number
  maxReadBytes?: number
  signal?: AbortSignal
}
export interface MeetingRelatedHistoryEntry {
  meeting: MeetingHistoryEntry
  sharedPerson: boolean
  sharedProject: boolean
}
export interface MeetingRelatedHistoryStore {
  /** Same-account meetings outside the series, joined through explicit people or confirmed projects. */
  relatedHistory(input: MeetingRelatedHistoryRequest): Promise<{
    items: MeetingRelatedHistoryEntry[]
    hasMore: boolean
  }>
}

export const validateMeetingRelatedHistory = (original: MeetingRelatedHistoryRequest) => {
  if (!original || typeof original !== "object" || Array.isArray(original))
    throw new CliError("validation_error", "related history request is required")
  const input = { ...original }
  for (const field of Object.keys(input))
    if (!["accountId", "seriesId", "anchorIds", "after", "before", "limit", "maxReadBytes", "signal"].includes(field))
      throw new CliError("validation_error", `unknown related history field: ${field}`)
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0
  if (!positive(input.accountId) || !positive(input.seriesId))
    throw new CliError("validation_error", "accountId and seriesId must be positive safe integers")
  if (!Array.isArray(input.anchorIds) || input.anchorIds.length > 20 || input.anchorIds.some((id) => !positive(id)))
    throw new CliError("validation_error", "anchorIds must contain at most 20 positive safe integers")
  for (const key of ["after", "before"] as const)
    if (!Number.isSafeInteger(input[key]) || Math.abs(input[key]) > 8640000000000000)
      throw new CliError("validation_error", `${key} must be an absolute timestamp`)
  if (input.after >= input.before) throw new CliError("validation_error", "after must precede before")
  const limit = input.limit === undefined ? 5 : input.limit
  const maxReadBytes = input.maxReadBytes === undefined ? 262144 : input.maxReadBytes
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
    throw new CliError("validation_error", "limit must be an integer from 1 to 20")
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > 4194304)
    throw new CliError("validation_error", "maxReadBytes must be an integer from 1 to 4194304")
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    throw new CliError("validation_error", "signal must be an AbortSignal")
  input.signal?.throwIfAborted()
  return { ...input, anchorIds: [...new Set(input.anchorIds)], limit, maxReadBytes }
}
