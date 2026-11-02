import type { MeetingCounts, MeetingCountsGrouping, MeetingHitSearchRequest, MeetingStats } from "../meetings/index.js"
import type { MessageStore } from "../store/store.js"
import { resolveMeetingSelection } from "./meeting-hit-search.js"

export type MeetingStatsRequest = Omit<MeetingHitSearchRequest, "limit" | "after" | "maxReadBytes"> & {
  timeZone?: string
  maxRows?: number
}

/** Talk time and lines per speaker and meetings per week over the meetings search would read, names resolved alike. */
export const readMeetingStats = async (
  store: Pick<MessageStore, "meetings"> & { knowledge?: MessageStore["knowledge"] },
  request: MeetingStatsRequest,
): Promise<MeetingStats & { selection: Awaited<ReturnType<typeof resolveMeetingSelection>>["selection"] }> => {
  const { timeZone, maxRows, ...selecting } = request
  const { input, selection } = await resolveMeetingSelection(store, selecting)
  const stats = await store.meetings.meetingStats({
    ...input,
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(maxRows === undefined ? {} : { maxRows }),
  })
  return { ...stats, selection }
}

export type MeetingCountsRequest = Omit<MeetingHitSearchRequest, "limit" | "after" | "maxReadBytes"> & {
  by: MeetingCountsGrouping
  timeZone?: string
  limit?: number
}

/** Meetings, minutes and transcripts per day, week or series over the meetings search would read. */
export const readMeetingCounts = async (
  store: Pick<MessageStore, "meetings"> & { knowledge?: MessageStore["knowledge"] },
  request: MeetingCountsRequest,
): Promise<MeetingCounts & { selection: Awaited<ReturnType<typeof resolveMeetingSelection>>["selection"] }> => {
  const { by, timeZone, limit, ...selecting } = request
  const { input, selection } = await resolveMeetingSelection(store, selecting)
  const counts = await store.meetings.meetingCounts({
    ...input,
    by,
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(limit === undefined ? {} : { limit }),
  })
  return { ...counts, selection }
}
