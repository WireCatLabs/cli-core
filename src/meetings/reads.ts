import { CliError } from "@wirecat/cli-base"
import { parseLucene, type QueryAst, validateQuery } from "@wirecat/cli-base/query"
import { type ListEnvelope, STEPS, type StepDefinition, stepOf } from "@wirecat/cli-base/standards"
import {
  type MeetingDetailsItem,
  type MeetingItemBody,
  type MeetingListBody,
  type MeetingSummaryItem,
  type MeetingTranscriptItem,
  meetingDetailsItem,
  meetingSummaryItem,
  meetingTranscriptItem,
  wholeList,
} from "./answers.js"
import { MEETING_QUERY, type MeetingItem, type MeetingOwner, meetingItem } from "./item.js"
import {
  type MeetingParticipantSearchOptions,
  type MeetingParticipantSearchStore,
  validateMeetingParticipantQuery,
  validateMeetingParticipantSearch,
} from "./participant-search.js"
import type { MeetingDetails, MeetingFilter, MeetingStore } from "./store.js"

export class MeetingError extends CliError {
  constructor(code: "validation_error" | "not_found" | "configuration_error", message: string) {
    super(code, message)
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
export const listed = <T>(
  items: T[],
  page: { limit: number; hasMore: boolean } = { limit: items.length, hasMore: false },
) => ({
  items,
  page: 1,
  ...page,
})
export const meetingPeople = async (
  store: MeetingStore & Partial<MeetingParticipantSearchStore>,
  query: string,
  accountId?: number,
  options: Omit<MeetingParticipantSearchOptions, "accountId"> = {},
) => {
  if (accountId === undefined) validateMeetingParticipantQuery(query)
  else validateMeetingParticipantSearch(query, { ...options, accountId })
  if (store.participantCandidates && accountId === undefined)
    throw new MeetingError("configuration_error", "select an account for bounded participant lookup")
  if (accountId !== undefined && store.participantCandidates) {
    const { limit, has_more, next_cursor, ...packet } = await store.participantCandidates(query, {
      ...options,
      accountId,
    })
    return {
      ...packet,
      page: { mode: "cursor", limit, has_more, ...(next_cursor ? { next_cursor } : {}) },
      ...(next_cursor
        ? {
            next: [
              stepOf(PAGE_NEXT, {
                command: "meetings people",
                args: {
                  query,
                  limit,
                  ...(options.scanLimit === undefined ? {} : { scan_limit: options.scanLimit }),
                  ...(options.maxReadBytes === undefined ? {} : { max_read_bytes: options.maxReadBytes }),
                  cursor: next_cursor,
                },
                values: { shown: packet.items.length },
              }),
            ],
          }
        : {}),
    }
  }
  if (Object.values(options).some((value) => value !== undefined))
    throw new MeetingError(
      "configuration_error",
      "bounded participant lookup needs a selected account and capable store",
    )
  return listed(await store.participants(query, accountId))
}

/** A list answer without `meta`: the host adds it, as it knows the run. */
export type MeetingList = Omit<ListEnvelope<MeetingItem>, "meta">

const PAGE_NEXT = STEPS.find((step) => step.id === "page.next") as StepDefinition

/** Newest first; `filter.query` is a list query `meetingsQuery` validated. */
export const meetingsList = async (store: MeetingStore, filter: MeetingFilter = {}, page = 1): Promise<MeetingList> => {
  validateFilter(filter)
  positiveInteger(page)
  const limit = positiveInteger(filter.limit ?? 100)
  const offset = (page - 1) * limit
  if (!Number.isSafeInteger(offset + limit + 1))
    throw new MeetingError("validation_error", "pagination exceeds safe integer range")
  const rows = await store.meetings({ ...filter, limit: limit + 1, offset })
  const shown = rows.slice(0, limit)
  const owners = new Map<number, MeetingOwner>()
  for (const { accountId } of shown) {
    if (owners.has(accountId)) continue
    const owner = await store.account(accountId)
    if (!owner) throw new MeetingError("not_found", `meeting account ${accountId} is not in the store`)
    owners.set(accountId, owner)
  }
  const has_more = rows.length > limit
  return {
    items: shown.map((row) => meetingItem(row, owners.get(row.accountId) as MeetingOwner)),
    page: { mode: "page", limit, has_more, ...(has_more ? { next_page: page + 1 } : {}) },
    ...(has_more
      ? {
          next: [
            stepOf(PAGE_NEXT, { command: "meetings list", args: { page: page + 1, limit }, values: { shown: limit } }),
          ],
        }
      : {}),
  }
}

/** The query `meetings list` and `meetings_list` take, validated; `undefined` when nothing narrows the list. */
export const meetingsQuery = (text: string | undefined): QueryAst | undefined => {
  if (text === undefined || text.trim() === "") return undefined
  const context = { command: "meetings list", guide: MEETING_QUERY_GUIDE }
  const query = parseLucene(text, { defaultField: "none", ...context })
  validateQuery(query, MEETING_QUERY, context)
  return query
}

export const MEETING_QUERY_GUIDE = "https://github.com/WireCatLabs/cli-core/blob/main/docs/search/query-language.md"
export interface TranscriptReadOptions {
  history?: boolean
}
const ownerOf = async (store: MeetingStore, accountId: number): Promise<MeetingOwner> => {
  const owner = await store.account(accountId)
  if (!owner) throw new MeetingError("not_found", `meeting account ${accountId} is not in the store`)
  return owner
}
/** `meetings show`: one item, the meeting with its people, chat, transcripts named by `ref` and summaries. */
export const meetingDetailsAnswer = async (
  store: MeetingStore,
  id: number,
  accountId?: number,
): Promise<MeetingItemBody<MeetingDetailsItem>> => {
  const details = await meetingShow(store, id, accountId)
  return { item: meetingDetailsItem(details, await ownerOf(store, details.meeting.accountId)) }
}
export const meetingTranscriptAnswer = async (
  store: MeetingStore,
  id: number,
  accountId?: number,
  options: TranscriptReadOptions = {},
): Promise<MeetingListBody<MeetingTranscriptItem>> => {
  const details = await meetingShow(store, id, accountId)
  return wholeList(
    details.transcripts
      .filter((t) => (options.history || t.transcript.supersededAt === null) && t.transcript.deletedAt === null)
      .map((t) => meetingTranscriptItem(details.meeting.accountId, t.transcript, t.rows)),
  )
}
export const meetingSummaryAnswer = async (
  store: MeetingStore,
  id: number,
  accountId?: number,
): Promise<MeetingListBody<MeetingSummaryItem>> => {
  const details = await meetingShow(store, id, accountId)
  return wholeList(details.summaries.map((one) => meetingSummaryItem(details.meeting.accountId, one)))
}
export const meetingsSearch = async (store: MeetingStore, query: string, filter: MeetingFilter = {}) => {
  validateFilter(filter)
  if (!query.trim()) throw new MeetingError("validation_error", "query must not be empty")
  return listed(await store.search(query, filter))
}
