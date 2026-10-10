import type { MeetingDetails, MeetingFilter, MeetingStore } from "./store.js"

export class MeetingError extends Error {
  constructor(
    readonly code: "validation_error" | "not_found" | "configuration_error",
    message: string,
  ) {
    super(message)
  }
}
export const positiveInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new MeetingError("validation_error", "expected a positive integer")
  return value
}
const validateFilter = (filter: MeetingFilter): void => {
  for (const value of [filter.accountId, filter.eventId, filter.meetingSeriesId])
    if (value !== undefined) positiveInteger(value)
  for (const value of [filter.since, filter.until])
    if (value !== undefined && !Number.isFinite(value))
      throw new MeetingError("validation_error", "expected epoch milliseconds")
  if (filter.since !== undefined && filter.until !== undefined && filter.since > filter.until)
    throw new MeetingError("validation_error", "since must not exceed until")
  for (const value of [filter.limit, filter.offset])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new MeetingError("validation_error", "expected a nonnegative integer")
}
export const meetingShow = async (store: MeetingStore, id: number, accountId?: number): Promise<MeetingDetails> => {
  const details = await store.meeting(positiveInteger(id))
  if (!details || (accountId !== undefined && details.meeting.accountId !== accountId))
    throw new MeetingError("not_found", "meeting not found")
  return details
}
export const listed = <T>(items: T[]) => ({ items, page: 1, limit: items.length, hasMore: false })
export const meetingsList = async (store: MeetingStore, filter: MeetingFilter = {}, page = 1) => {
  validateFilter(filter)
  positiveInteger(page)
  const limit = positiveInteger(filter.limit ?? 100)
  const offset = (page - 1) * limit
  if (!Number.isSafeInteger(offset + limit + 1))
    throw new MeetingError("validation_error", "pagination exceeds safe integer range")
  const rows = await store.meetings({ ...filter, limit: limit + 1, offset })
  return { items: rows.slice(0, limit), page, limit, hasMore: rows.length > limit }
}
export interface TranscriptReadOptions {
  history?: boolean
}
export const meetingTranscript = async (
  store: MeetingStore,
  id: number,
  accountId?: number,
  options: TranscriptReadOptions = {},
) => {
  const details = await meetingShow(store, id, accountId)
  return listed(
    details.transcripts.filter(
      (t) => (options.history || t.transcript.supersededAt === null) && t.transcript.deletedAt === null,
    ),
  )
}
export const meetingSummary = async (store: MeetingStore, id: number, accountId?: number) =>
  listed((await meetingShow(store, id, accountId)).summaries)
export const meetingsSearch = async (store: MeetingStore, query: string, filter: MeetingFilter = {}) => {
  validateFilter(filter)
  if (!query.trim()) throw new MeetingError("validation_error", "query must not be empty")
  return listed(await store.search(query, filter))
}
