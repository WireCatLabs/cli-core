import { CliError } from "@wirecat/cli-base"
import {
  CALL_DIRECTIONS,
  CALL_OUTCOMES,
  type Call,
  type CallDirection,
  type CallEmployee,
  type CallOutcome,
  MISSED_OUTCOMES,
} from "./calls.js"
import { dayKey, zoneFormat, zoneOf } from "./stats.js"

export const CALLBACK_WITHIN_MS = 24 * 60 * 60 * 1000
/** call-qa's layer-1 filter grades only calls of 30 seconds or more; shorter ones are reported as short. */
export const SHORT_CALL_UNDER_MS = 30_000
const MOST_MISSED = 100

export interface CallStatsOptions {
  timeZone?: string
  /** How long after a missed call a callback counts. */
  callbackWithinMs?: number
  shortCallUnderMs?: number
  /** Most missed calls listed one by one; all are counted. */
  missedLimit?: number
  /** Other calls of the account, read only to find callbacks: after the selection, or by employees it leaves out. */
  later?: readonly Call[]
}

type Counts<K extends string> = Record<K | "unknown", number>

/**
 * A key no call of the selection can give is absent: `placed`, `answered` and `rangNotAnswered` when the provider
 * never says who took a call, talk and wait when it records neither.
 */
export interface CallEmployeeStats extends CallEmployee {
  calls: number
  incoming: number
  outgoing: number
  internal: number
  placed?: number
  answered?: number
  rangNotAnswered?: number
  /** Over the calls this employee placed or answered. */
  talkMs?: number
  /** `null` when this employee talked on no call. */
  meanTalkMs?: number | null
  /** Over the incoming calls this employee answered first; `null` when none. */
  meanWaitMs?: number | null
  maxWaitMs?: number | null
}

export interface CallPeriodStats {
  calls: number
  incoming: number
  outgoing: number
  internal: number
  answered?: number
  missed?: number
  talkMs?: number
}

export interface CallCallback {
  meetingId: number
  startedAt: number
  afterMs: number
  direction: "outgoing" | "incoming"
}

export interface MissedCall {
  meetingId: number
  startedAt: number | null
  outcome: CallOutcome
  client: { key: string; name: string | null } | null
  rang: string[]
  /** Absent when the client is unknown or the call has no start, so nobody can tell. */
  calledBack?: boolean
  /** `null` when it was not called back within the window. */
  callback?: CallCallback | null
}

/**
 * Counts are over the calls that give the field, and `known` says how many do. A key no call gives is absent, never
 * zero; `null` means known to have no value, such as the mean wait when no incoming call was answered.
 */
export interface CallStats {
  timeZone: string
  callbackWithinMs: number
  shortCallUnderMs: number
  calls: number
  known: { direction: number; outcome: number; waitMs: number; talkMs: number; durationMs: number; roles: number }
  byDirection?: Counts<CallDirection>
  byOutcome?: Counts<CallOutcome>
  talkMs?: number
  meanTalkMs?: number
  durationMs?: number
  /** Over the answered incoming calls. */
  meanWaitMs?: number | null
  maxWaitMs?: number | null
  /** Answered calls with known talk shorter than `shortCallUnderMs`. */
  shortCalls?: number
  employees: CallEmployeeStats[]
  /** All 24 hours of the day in the zone. */
  hours: (CallPeriodStats & { hour: number })[]
  /** The days with a call, in the zone, oldest first. */
  days: (CallPeriodStats & { date: string })[]
  /** Absent when no call gives its outcome. */
  missed?: {
    /** Incoming calls that went to voicemail, were busy or not answered. */
    calls: number
    calledBack: number
    notCalledBack: number
    /** Missed calls with no known client or no start. */
    unknownCallback: number
    /** Incoming calls whose outcome is unknown, so whether they were missed is too. */
    unknownOutcome: number
    items: MissedCall[]
    hasMore: boolean
  }
}

const countsOf = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries([...keys, "unknown"].map((key) => [key, 0])) as Counts<K>

const isMissed = (call: Call) =>
  call.direction === "incoming" && call.outcome !== null && MISSED_OUTCOMES.includes(call.outcome)

const mean = (sum: number, count: number) => (count === 0 ? null : Math.round(sum / count))

const positiveMs = (value: number | undefined, fallback: number, name: string) => {
  const ms = value ?? fallback
  if (!Number.isSafeInteger(ms) || ms < 1) throw new CliError("validation_error", `${name} is a positive duration`)
  return ms
}

const hourFormat = (zone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", hourCycle: "h23" })

/** A later call that answers a missed one: the business called the client, or the client got through. */
const answersMissed = (missed: Call, later: Call, within: number) =>
  missed.startedAt !== null &&
  later.startedAt !== null &&
  later.startedAt > missed.startedAt &&
  later.startedAt - missed.startedAt <= within &&
  (later.direction === "outgoing" || (later.direction === "incoming" && later.outcome === "answered"))

const when = <T extends object>(present: boolean, value: T): Partial<T> => (present ? value : {})

const period = () => ({ calls: 0, incoming: 0, outgoing: 0, internal: 0, answered: 0, missed: 0, talkMs: 0 })
type Period = ReturnType<typeof period>

/**
 * Layer-1 call numbers over calls a phone system recorded: totals by direction and outcome, per employee, by hour and
 * day in a zone, missed incoming calls and their callbacks, and short calls. A transferred call's talk counts for each
 * employee who answered it.
 */
export const aggregateCallStats = (calls: readonly Call[], options: CallStatsOptions = {}): CallStats => {
  const zone = zoneOf(options.timeZone)
  const within = positiveMs(options.callbackWithinMs, CALLBACK_WITHIN_MS, "--within")
  const short = positiveMs(options.shortCallUnderMs, SHORT_CALL_UNDER_MS, "the short-call threshold")
  const limit = options.missedLimit ?? MOST_MISSED
  if (!Number.isSafeInteger(limit) || limit < 0) throw new CliError("validation_error", "--limit is a positive number")
  const known = {
    direction: calls.filter((call) => call.direction !== null).length,
    outcome: calls.filter((call) => call.outcome !== null).length,
    waitMs: calls.filter((call) => call.waitMs !== null).length,
    talkMs: calls.filter((call) => call.talkMs !== null).length,
    durationMs: calls.filter((call) => call.durationMs !== null).length,
    roles: calls.filter((call) => call.roles).length,
  }
  const has = { outcome: known.outcome > 0, talk: known.talkMs > 0, wait: known.waitMs > 0, roles: known.roles > 0 }
  const days = zoneFormat(zone)
  const hourOf = hourFormat(zone)
  const byDirection = countsOf(CALL_DIRECTIONS)
  const byOutcome = countsOf(CALL_OUTCOMES)
  let talk = 0
  let duration = 0
  let wait = { sum: 0, count: 0, max: null as number | null }
  let shortCalls = 0
  const employees = new Map<
    string,
    CallEmployee &
      Period & {
        placed: number
        rangNotAnswered: number
        talks: number
        waits: number
        waitSum: number
        maxWaitMs: number | null
      }
  >()
  const hours = Array.from({ length: 24 }, period)
  const dayRows = new Map<string, Period>()
  const employee = (one: CallEmployee) => {
    const held = employees.get(one.key) ?? {
      ...one,
      ...period(),
      placed: 0,
      rangNotAnswered: 0,
      talks: 0,
      waits: 0,
      waitSum: 0,
      maxWaitMs: null,
    }
    held.name ??= one.name
    held.identityId ??= one.identityId
    employees.set(one.key, held)
    return held
  }
  const addTo = (row: Period, call: Call) => {
    row.calls += 1
    if (call.direction) row[call.direction] += 1
    if (call.outcome === "answered") row.answered += 1
    if (isMissed(call)) row.missed += 1
    row.talkMs += call.talkMs ?? 0
  }
  for (const call of calls) {
    byDirection[call.direction ?? "unknown"] += 1
    byOutcome[call.outcome ?? "unknown"] += 1
    talk += call.talkMs ?? 0
    duration += call.durationMs ?? 0
    if (call.outcome === "answered" && call.talkMs !== null && call.talkMs < short) shortCalls += 1
    if (call.direction === "incoming" && call.outcome === "answered" && call.waitMs !== null)
      wait = { sum: wait.sum + call.waitMs, count: wait.count + 1, max: Math.max(wait.max ?? 0, call.waitMs) }
    const talkers = new Set([
      ...call.answeredBy.map(({ key }) => key),
      ...(call.placedBy && call.outcome === "answered" ? [call.placedBy.key] : []),
    ])
    for (const one of call.employees) {
      const held = employee(one)
      held.calls += 1
      if (call.direction) held[call.direction] += 1
      if (call.placedBy?.key === one.key) held.placed += 1
      if (call.answeredBy.some(({ key }) => key === one.key)) held.answered += 1
      if (call.rang.some(({ key }) => key === one.key)) held.rangNotAnswered += 1
      if (talkers.has(one.key) && call.talkMs !== null) {
        held.talkMs += call.talkMs
        held.talks += 1
      }
      if (call.direction === "incoming" && call.answeredBy[0]?.key === one.key && call.waitMs !== null) {
        held.waits += 1
        held.waitSum += call.waitMs
        held.maxWaitMs = Math.max(held.maxWaitMs ?? 0, call.waitMs)
      }
    }
    if (call.startedAt !== null) {
      const hour = hours[Number(hourOf.format(new Date(call.startedAt))) % 24]
      if (hour) addTo(hour, call)
      const date = dayKey(call.startedAt, days)
      const row = dayRows.get(date) ?? period()
      addTo(row, call)
      dayRows.set(date, row)
    }
  }
  const periodOf = ({ answered, missed, talkMs, ...row }: Period): CallPeriodStats => ({
    ...row,
    ...when(has.outcome, { answered, missed }),
    ...when(has.talk, { talkMs }),
  })
  const byClient = new Map<string, Call[]>()
  for (const call of [...calls, ...(options.later ?? [])]) {
    if (!call.client) continue
    const list = byClient.get(call.client.key) ?? []
    list.push(call)
    byClient.set(call.client.key, list)
  }
  for (const list of byClient.values()) list.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  const missedCalls = calls
    .filter(isMissed)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .map((call): MissedCall => {
      const { client, startedAt } = call
      const found = client ? byClient.get(client.key)?.find((one) => answersMissed(call, one, within)) : undefined
      return {
        meetingId: call.meetingId,
        startedAt,
        outcome: call.outcome as CallOutcome,
        client: client ? { key: client.key, name: client.name } : null,
        rang: call.rang.map(({ key }) => key),
        ...when(client !== null && startedAt !== null, {
          calledBack: found !== undefined,
          callback:
            found && found.startedAt !== null && startedAt !== null
              ? {
                  meetingId: found.meetingId,
                  startedAt: found.startedAt,
                  afterMs: found.startedAt - startedAt,
                  direction: found.direction as "outgoing" | "incoming",
                }
              : null,
        }),
      }
    })
  return {
    timeZone: zone,
    callbackWithinMs: within,
    shortCallUnderMs: short,
    calls: calls.length,
    known,
    ...when(known.direction > 0, { byDirection }),
    ...when(has.outcome, { byOutcome }),
    ...when(has.talk, { talkMs: talk, meanTalkMs: Math.round(talk / known.talkMs) }),
    ...when(known.durationMs > 0, { durationMs: duration }),
    ...when(has.wait, { meanWaitMs: mean(wait.sum, wait.count), maxWaitMs: wait.max }),
    ...when(has.outcome && has.talk, { shortCalls }),
    employees: [...employees.values()]
      .map(({ talks, waits, waitSum, placed, answered, rangNotAnswered, talkMs, maxWaitMs, missed: _, ...one }) => ({
        key: one.key,
        name: one.name,
        identityId: one.identityId,
        extension: one.extension,
        calls: one.calls,
        incoming: one.incoming,
        outgoing: one.outgoing,
        internal: one.internal,
        ...when(has.roles, { placed, answered, rangNotAnswered }),
        ...when(has.roles && has.talk, { talkMs, meanTalkMs: mean(talkMs, talks) }),
        ...when(has.roles && has.wait, { meanWaitMs: mean(waitSum, waits), maxWaitMs }),
      }))
      .sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key)),
    hours: hours.map((row, hour) => ({ hour, ...periodOf(row) })),
    days: [...dayRows.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, row]) => ({ date, ...periodOf(row) })),
    ...when(has.outcome, {
      missed: {
        calls: missedCalls.length,
        calledBack: missedCalls.filter((one) => one.calledBack === true).length,
        notCalledBack: missedCalls.filter((one) => one.calledBack === false).length,
        unknownCallback: missedCalls.filter((one) => one.calledBack === undefined).length,
        unknownOutcome: calls.filter((call) => call.direction === "incoming" && call.outcome === null).length,
        items: missedCalls.slice(0, limit),
        hasMore: missedCalls.length > limit,
      },
    }),
  }
}
