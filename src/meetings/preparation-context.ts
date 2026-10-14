import { CliError } from "@wirecat/cli-base"

export interface MeetingPreparationContextRequest {
  accountId: number
  meetingId: number
  seriesId: number
  updatedAt: number
  limit?: number
  maxReadBytes?: number
  signal?: AbortSignal
}
export interface PreparationPage<T> {
  items: T[]
  hasMore: boolean
}
export interface MeetingPreparationContext {
  participants: PreparationPage<{
    id: number
    identityId: number
    displayName: string | null
    personUid: string | null
  }>
  projects: PreparationPage<{ ref: string; key: string; name: string; linkId: number }>
  facts: PreparationPage<{ ref: string; type: string; statement: string; updatedAt: number }>
  tasks: PreparationPage<{
    ref: string
    key: string
    title: string
    status: string
    priority: number | null
    source: string | null
  }>
}
export interface MeetingPreparationContextStore {
  /** Bounded observed people, confirmed projects, accepted subject facts and directly sourced tasks. */
  preparationContext(input: MeetingPreparationContextRequest): Promise<MeetingPreparationContext>
}
export const validateMeetingPreparationContext = (original: MeetingPreparationContextRequest) => {
  if (!original || typeof original !== "object" || Array.isArray(original))
    throw new CliError("validation_error", "meeting preparation context is required")
  const input = { ...original }
  for (const key of Object.keys(input))
    if (!["accountId", "meetingId", "seriesId", "updatedAt", "limit", "maxReadBytes", "signal"].includes(key))
      throw new CliError("validation_error", `unknown preparation context field: ${key}`)
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    throw new CliError("validation_error", "signal must be an AbortSignal")
  input.signal?.throwIfAborted()
  for (const key of ["accountId", "meetingId", "seriesId"] as const)
    if (!Number.isSafeInteger(input[key]) || input[key] <= 0)
      throw new CliError("validation_error", `${key} must be a positive safe integer`)
  if (!Number.isSafeInteger(input.updatedAt) || Math.abs(input.updatedAt) > 8640000000000000)
    throw new CliError("validation_error", "updatedAt must be an absolute timestamp")
  const limit = input.limit === undefined ? 20 : input.limit
  const maxReadBytes = input.maxReadBytes === undefined ? 262144 : input.maxReadBytes
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new CliError("validation_error", "limit must be an integer from 1 to 100")
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > 4194304)
    throw new CliError("validation_error", "maxReadBytes must be an integer from 1 to 4194304")
  return { ...input, limit, maxReadBytes }
}
