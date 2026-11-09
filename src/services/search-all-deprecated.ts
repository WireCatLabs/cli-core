import type { AccountKey, MessageStore } from "../store/store.js"
import type { SearchFound, SearchQuery } from "./messages.js"
import type { MeaningLane } from "./messages-discovery.js"
import {
  type SearchAllFound,
  type SearchAllMessenger,
  type SearchAllRequest,
  type SearchedResource,
  searchAll,
} from "./search-all.js"

/** @deprecated use `SearchedResource` — removed once zoom-cli moves (zoom-cli#344) */
export type ResourceWithMeetings = SearchedResource

/** @deprecated meetings are paged by `offset` — removed once zoom-cli moves (zoom-cli#344) */
export interface MeetingSearchCursor {
  accountId: number
  query: string
  meetingOffset: number
  hitOffset: number
}

/** @deprecated use `SearchAllRequest` — removed once zoom-cli moves (zoom-cli#344) */
export interface SearchAllIncludingMeetingsRequest extends SearchAllRequest {
  /** Read only this meeting account, as `scope.meetings`. */
  meetingAccount?: AccountKey
  /** Ignored: every meeting of an account is read through its search index. */
  maxMeetings?: number | "all"
  /** Ignored: the next page is `offset`. */
  meetingCursor?: MeetingSearchCursor
}

/** @deprecated use `MeetingAccountCoverage` — removed once zoom-cli moves (zoom-cli#344) */
export interface MeetingSearchCoverage {
  accountId: number
  by: "word-prefixes"
  meetingsScanned: number
  complete: boolean
  nextCursor?: MeetingSearchCursor
}

/**
 * @deprecated use `SearchAllFound` — removed once zoom-cli moves (zoom-cli#344). `meetings` is never set: the index
 * has no bounded scan to report.
 */
export interface SearchAllIncludingMeetingsFound extends Omit<SearchAllFound, "hasMore" | "meetings"> {
  hasMore: boolean | null
  meetings?: MeetingSearchCoverage
}

/** @deprecated use `searchAll` with `scope.meetings` — removed once zoom-cli moves (zoom-cli#344) */
export const searchAllIncludingMeetings = async (
  store: MessageStore,
  account: AccountKey,
  {
    meetingAccount,
    maxMeetings: _maxMeetings,
    meetingCursor: _meetingCursor,
    ...request
  }: SearchAllIncludingMeetingsRequest,
  messenger: SearchAllMessenger = {},
  searchMessages?: (query: SearchQuery) => Promise<SearchFound>,
  meaning?: MeaningLane,
): Promise<SearchAllIncludingMeetingsFound> => {
  const { meetings: _meetings, ...found } = await searchAll(
    store,
    account,
    {
      ...request,
      ...(meetingAccount === undefined ? {} : { scope: { ...request.scope, meetings: [meetingAccount] } }),
      ...(request.only?.includes("meetings") ? { meetingsAsked: true } : {}),
    },
    messenger,
    searchMessages,
    meaning,
  )
  return found
}
