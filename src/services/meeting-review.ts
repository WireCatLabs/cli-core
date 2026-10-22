import type { MeetingHitSearchRequest, MeetingReview } from "../meetings/index.js"
import type { MessageStore } from "../store/store.js"
import { resolveMeetingSelection } from "./meeting-hit-search.js"

export type MeetingReviewRequest = Omit<MeetingHitSearchRequest, "limit" | "after" | "maxReadBytes"> & {
  limit?: number
}

/** The newest meetings of the selection with their summaries, talk and projects; names resolved as search does. */
export const readMeetingReview = async (
  store: Pick<MessageStore, "meetings"> & { knowledge?: MessageStore["knowledge"] },
  request: MeetingReviewRequest,
): Promise<MeetingReview & { selection: Awaited<ReturnType<typeof resolveMeetingSelection>>["selection"] }> => {
  const { limit, ...selecting } = request
  const { input, selection } = await resolveMeetingSelection(store, selecting)
  const review = await store.meetings.meetingReview({ ...input, ...(limit === undefined ? {} : { limit }) })
  return { ...review, selection }
}
