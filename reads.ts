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
export const meetingShow = async (store: MeetingStore, id: number, accountId?: number): Promise<MeetingDetails> => {
  const details = await store.meeting(positiveInteger(id))
  if (!details || (accountId !== undefined && details.meeting.accountId !== accountId))
    throw new MeetingError("not_found", "meeting not found")
  return details
}
export const listed = <T>(items: T[]) => ({ items, page: 1, limit: items.length, hasMore: false })
export const meetingsList = async (store: MeetingStore, filter: MeetingFilter = {}, page = 1) => {
  positiveInteger(page)
  const limit = positiveInteger(filter.limit ?? 100)
  const rows = await store.meetings({ ...filter, limit: limit + 1, offset: (page - 1) * limit })
  return { items: rows.slice(0, limit), page, limit, hasMore: rows.length > limit }
}
export const meetingTranscript = async (store: MeetingStore, id: number, accountId?: number) => {
  const details = await meetingShow(store, id, accountId)
  return listed(
    details.transcripts.filter((t) => t.transcript.supersededAt === null && t.transcript.deletedAt === null),
  )
}
export const meetingsSearch = async (store: MeetingStore, query: string, filter: MeetingFilter = {}) => {
  if (!query.trim()) throw new MeetingError("validation_error", "query must not be empty")
  return listed(await store.search(query, filter))
}
