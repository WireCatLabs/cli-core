import { CliError } from "@wirecat/cli-base"
import { type MeetingBatchReader, validateMeetingHitSearch } from "../meetings/index.js"
import type { MessageStore } from "../store/store.js"
import { searchMeetingHits } from "./meeting-hit-search.js"
import { readMeetingPassage } from "./meeting-passage-format.js"

/** One host-selected account; batch preparation and budget reservations happen before these callbacks. */
export const createMeetingBatchReader = (
  store: Pick<MessageStore, "meetings" | "knowledge">,
  accountId: number,
): MeetingBatchReader => {
  if (!Number.isSafeInteger(accountId) || accountId < 1)
    throw new CliError("validation_error", "choose a positive meeting account")
  return {
    index: (options) => store.meetings.indexSearch({ ...options, accountId, limit: 1000 }),
    search: (query, options) => {
      validateMeetingHitSearch(query, options)
      return searchMeetingHits(store, query, { ...options, accountId }, { refreshIndex: false })
    },
    passage: (reference, options) => readMeetingPassage(store.meetings, accountId, reference, options),
  }
}
