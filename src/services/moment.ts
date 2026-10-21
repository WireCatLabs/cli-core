import { CliError } from "@wirecat/cli-base"
import { timezoneOf } from "@wirecat/cli-base/query"
import { calendarMoment, type MomentZone } from "../domain/moment.js"

const AGO = /^(\d+)(m|h|d)$/
const AGO_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const DATE = /^\d{4}-\d{2}-\d{2}/

export type { MomentZone }

/** Shaped like a moment `momentOf` reads, whether or not it is a valid one. */
export const isMoment = (reference: string): boolean => {
  const wanted = reference.trim()
  return AGO.test(wanted) || DATE.test(wanted)
}

/**
 * `--since` as a moment: ISO 8601, or `30m`, `2h`, `1d` ago. Unlike max-cli, never a message id —
 * a MAX id carries its time, and a Telegram id is only a counter within one chat.
 */
export const momentOf = (reference: string, flag = "--since", now = Date.now(), at: MomentZone = {}): number => {
  const wanted = reference.trim()
  const [, amount, unit] = AGO.exec(wanted) ?? []
  // By shape: `Date.parse("12345")` is the year 12345, so a message id would pass as a date.
  const time =
    amount && unit
      ? now - Number(amount) * (AGO_MS[unit] ?? 0)
      : DATE.test(wanted)
        ? calendarMoment(wanted, flag, at)
        : Number.NaN
  if (Number.isNaN(time)) {
    throw new CliError("validation_error", `${flag} takes an ISO 8601 time or 30m, 2h, 1d ago — not "${wanted}"`)
  }
  return time
}

/**
 * A time ahead, for a due date or the next check: ISO 8601, or `30m`, `2h`, `3d` from now. `none`
 * is not a time; a caller that clears a date checks for it first.
 */
export const aheadOf = (reference: string, flag: string, now = Date.now(), at: MomentZone = {}): number => {
  const wanted = reference.trim()
  const [, amount, unit] = AGO.exec(wanted) ?? []
  const time =
    amount && unit
      ? now + Number(amount) * (AGO_MS[unit] ?? 0)
      : DATE.test(wanted)
        ? calendarMoment(wanted, flag, at)
        : Number.NaN
  if (Number.isNaN(time)) {
    throw new CliError("validation_error", `${flag} takes an ISO 8601 time or 30m, 2h, 3d from now — not "${wanted}"`)
  }
  return time
}

export interface DateWindow {
  since?: number
  until?: number
  /** What the answer says about it: the zone a value without one was read in, and the bounds in UTC. */
  meta: { timezone?: string; window?: { since?: string; until?: string } }
}

/** `--since-time` and `--until-time` together, as the filter and the `meta` an answer reports it by. */
export const dateWindow = ({
  sinceTime,
  untilTime,
  zone,
  now = Date.now(),
  names = ["--since-time", "--until-time"],
}: {
  sinceTime?: string
  untilTime?: string
  zone?: string
  now?: number
  /** How the caller spells the two, for the error: `since_time` over MCP. */
  names?: [string, string]
}): DateWindow => {
  const since = sinceTime === undefined ? undefined : momentOf(sinceTime, names[0], now, { zone })
  const until = untilTime === undefined ? undefined : momentOf(untilTime, names[1], now, { zone, end: true })
  const readInZone = [sinceTime, untilTime].some(
    (value) => value !== undefined && DATE.test(value.trim()) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim()),
  )
  const window = {
    ...(since === undefined ? {} : { since: new Date(since).toISOString() }),
    ...(until === undefined ? {} : { until: new Date(until).toISOString() }),
  }
  return {
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    meta: {
      ...(readInZone ? { timezone: timezoneOf(zone) } : {}),
      ...(since === undefined && until === undefined ? {} : { window }),
    },
  }
}
