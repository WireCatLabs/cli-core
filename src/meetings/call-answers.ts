import { isoTime, reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import type { CallPeriodStats, CallStats } from "./call-stats.js"
import { CALL_DIRECTIONS, CALL_OUTCOMES } from "./calls.js"
import { formatMeetingReference } from "./reference.js"

const count = v.pipe(v.number(), v.integer(), v.minValue(0))
const ms = count
const id = v.pipe(v.number(), v.integer(), v.minValue(1))
const counts = (keys: readonly string[]) =>
  v.strictObject(Object.fromEntries([...keys, "unknown"].map((key) => [key, count])) as Record<string, typeof count>)
const maybe = v.exactOptional

const employee = v.strictObject({
  /** `extension:<number>`, or `identity:<id>` where the provider names no extension. */
  key: v.string(),
  name: v.nullable(v.string()),
  identity_id: v.nullable(id),
  extension: v.nullable(v.string()),
  calls: count,
  incoming: count,
  outgoing: count,
  internal: count,
  placed: maybe(count),
  answered: maybe(count),
  rang_not_answered: maybe(count),
  talk_ms: maybe(ms),
  mean_talk_ms: maybe(v.nullable(ms)),
  mean_wait_ms: maybe(v.nullable(ms)),
  max_wait_ms: maybe(v.nullable(ms)),
})

const periodFields = {
  calls: count,
  incoming: count,
  outgoing: count,
  internal: count,
  answered: maybe(count),
  missed: maybe(count),
  talk_ms: maybe(ms),
}

const callRef = v.strictObject({ ref: reference, meeting_id: id, started_at: v.nullable(isoTime) })

/**
 * `stats calls show`: layer-1 numbers over stored phone calls. Counts are over the calls that give the field, and
 * `known` says how many do; a key no call gives is absent, never zero.
 */
const callStatsSchema = v.strictObject({
  time_zone: v.string(),
  callback_within_ms: ms,
  short_call_under_ms: ms,
  calls: count,
  /** Selected meetings that are not calls. */
  not_calls: count,
  /** How many calls give each field; `roles` says who placed, answered and rang. */
  known: v.strictObject({
    direction: count,
    outcome: count,
    wait_ms: count,
    talk_ms: count,
    duration_ms: count,
    roles: count,
  }),
  by_direction: maybe(counts(CALL_DIRECTIONS)),
  by_outcome: maybe(counts(CALL_OUTCOMES)),
  talk_ms: maybe(ms),
  mean_talk_ms: maybe(ms),
  duration_ms: maybe(ms),
  mean_wait_ms: maybe(v.nullable(ms)),
  max_wait_ms: maybe(v.nullable(ms)),
  short_calls: maybe(count),
  employees: v.array(employee),
  /** Hours 0–23 in `time_zone`. */
  hours: v.array(v.strictObject({ hour: v.pipe(count, v.maxValue(23)), ...periodFields })),
  /** `YYYY-MM-DD` in `time_zone`, the days with a call. */
  days: v.array(v.strictObject({ date: v.string(), ...periodFields })),
  missed: maybe(
    v.strictObject({
      calls: count,
      called_back: count,
      not_called_back: count,
      unknown_callback: count,
      unknown_outcome: count,
      /** Newest first. */
      items: v.array(
        v.strictObject({
          ...callRef.entries,
          outcome: v.picklist(["voicemail", "busy", "no_answer"]),
          client: v.nullable(v.strictObject({ key: v.string(), name: v.nullable(v.string()) })),
          rang: v.array(v.string()),
          called_back: maybe(v.boolean()),
          callback: maybe(
            v.nullable(
              v.strictObject({ ...callRef.entries, after_ms: ms, direction: v.picklist(["outgoing", "incoming"]) }),
            ),
          ),
        }),
      ),
      has_more: v.boolean(),
    }),
  ),
})

export type CallStatsItem = v.InferOutput<typeof callStatsSchema>
export const callStats: v.GenericSchema<CallStatsItem> = callStatsSchema

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString())
const has = <K extends string, T>(key: K, value: T | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, T>>

const periodItem = (row: CallPeriodStats) => ({
  calls: row.calls,
  incoming: row.incoming,
  outgoing: row.outgoing,
  internal: row.internal,
  ...has("answered", row.answered),
  ...has("missed", row.missed),
  ...has("talk_ms", row.talkMs),
})

export const callStatsItem = (found: CallStats & { accountId: number; notCalls: number }): CallStatsItem => {
  const refOf = (meetingId: number, startedAt: number | null) => ({
    ref: formatMeetingReference({ type: "meeting", accountId: found.accountId, meetingId }),
    meeting_id: meetingId,
    started_at: iso(startedAt),
  })
  return {
    time_zone: found.timeZone,
    callback_within_ms: found.callbackWithinMs,
    short_call_under_ms: found.shortCallUnderMs,
    calls: found.calls,
    not_calls: found.notCalls,
    known: {
      direction: found.known.direction,
      outcome: found.known.outcome,
      wait_ms: found.known.waitMs,
      talk_ms: found.known.talkMs,
      duration_ms: found.known.durationMs,
      roles: found.known.roles,
    },
    ...has("by_direction", found.byDirection),
    ...has("by_outcome", found.byOutcome),
    ...has("talk_ms", found.talkMs),
    ...has("mean_talk_ms", found.meanTalkMs),
    ...has("duration_ms", found.durationMs),
    ...has("mean_wait_ms", found.meanWaitMs),
    ...has("max_wait_ms", found.maxWaitMs),
    ...has("short_calls", found.shortCalls),
    employees: found.employees.map((one) => ({
      key: one.key,
      name: one.name,
      identity_id: one.identityId,
      extension: one.extension,
      calls: one.calls,
      incoming: one.incoming,
      outgoing: one.outgoing,
      internal: one.internal,
      ...has("placed", one.placed),
      ...has("answered", one.answered),
      ...has("rang_not_answered", one.rangNotAnswered),
      ...has("talk_ms", one.talkMs),
      ...has("mean_talk_ms", one.meanTalkMs),
      ...has("mean_wait_ms", one.meanWaitMs),
      ...has("max_wait_ms", one.maxWaitMs),
    })),
    hours: found.hours.map((row) => ({ hour: row.hour, ...periodItem(row) })),
    days: found.days.map((row) => ({ date: row.date, ...periodItem(row) })),
    ...has(
      "missed",
      found.missed && {
        calls: found.missed.calls,
        called_back: found.missed.calledBack,
        not_called_back: found.missed.notCalledBack,
        unknown_callback: found.missed.unknownCallback,
        unknown_outcome: found.missed.unknownOutcome,
        items: found.missed.items.map((one) => ({
          ...refOf(one.meetingId, one.startedAt),
          outcome: one.outcome as "voicemail" | "busy" | "no_answer",
          client: one.client,
          rang: one.rang,
          ...has("called_back", one.calledBack),
          ...has(
            "callback",
            one.callback === undefined
              ? undefined
              : one.callback && {
                  ...refOf(one.callback.meetingId, one.callback.startedAt),
                  after_ms: one.callback.afterMs,
                  direction: one.callback.direction,
                },
          ),
        })),
        has_more: found.missed.hasMore,
      },
    ),
  }
}
