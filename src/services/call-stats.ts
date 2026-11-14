import {
  aggregateCallStats,
  CALLBACK_WITHIN_MS,
  type Call,
  type CallStats,
  callOf,
  type MeetingCallsInput,
  type StoredCall,
} from "../meetings/index.js"
import type { MessageStore } from "../store/store.js"

export type CallStatsRequest = MeetingCallsInput & {
  timeZone?: string
  callbackWithinMs?: number
  missedLimit?: number
}

export type CallStatsAnswer = CallStats & {
  accountId: number
  /** Selected meetings that are not calls: no direction or outcome a phone system writes, and no client. */
  notCalls: number
}

const callsOf = (stored: readonly StoredCall[]) => stored.map(callOf).filter((one): one is Call => one !== null)

/**
 * The call numbers of one account over the selected meetings. A callback may come after `until` or from an employee
 * the selection leaves out, so the account's calls up to `callbackWithinMs` after the selection are read too.
 */
export const readCallStats = async (
  store: Pick<MessageStore, "meetings">,
  request: CallStatsRequest,
): Promise<CallStatsAnswer> => {
  const { timeZone, callbackWithinMs, missedLimit, ...selection } = request
  const within = callbackWithinMs ?? CALLBACK_WITHIN_MS
  const stored = await store.meetings.meetingCalls(selection)
  const calls = callsOf(stored)
  const narrowed = Object.keys(selection).some(
    (key) => !["accountId", "since", "until", "maxRows", "signal"].includes(key),
  )
  const end = selection.until === undefined ? undefined : selection.until + within
  // Narrowed to a person, a colleague's callback is outside the selection; otherwise only the time after it is.
  const window = narrowed
    ? {
        ...(selection.since === undefined ? {} : { since: selection.since }),
        ...(end === undefined ? {} : { until: end }),
      }
    : selection.until === undefined
      ? null
      : { since: selection.until + 1, until: end as number }
  const later =
    calls.length > 0 && window !== null && Number.isSafeInteger(within)
      ? callsOf(
          await store.meetings.meetingCalls({
            accountId: selection.accountId,
            ...window,
            ...(selection.maxRows === undefined ? {} : { maxRows: selection.maxRows }),
            ...(selection.signal ? { signal: selection.signal } : {}),
          }),
        )
      : []
  return {
    ...aggregateCallStats(calls, {
      ...(timeZone === undefined ? {} : { timeZone }),
      callbackWithinMs: within,
      ...(missedLimit === undefined ? {} : { missedLimit }),
      later,
    }),
    accountId: selection.accountId,
    notCalls: stored.length - calls.length,
  }
}
