import { CliError } from "@wirecat/cli-base"
import { timezoneOf, zonedMoment } from "@wirecat/cli-base/query"

export interface MomentZone {
  /** The IANA zone a date or a time without a zone is read in; the computer's zone when left out. */
  zone?: string
  /** A date alone means the last millisecond of that local day, not its first: the end of a range. */
  end?: boolean
}

/** A typed date or time as epoch ms, with the flag named when it is not one. */
export const calendarMoment = (wanted: string, flag: string, { zone, end = false }: MomentZone = {}): number => {
  try {
    return zonedMoment(wanted, timezoneOf(zone), { start: 0, end: wanted.length }, { end })
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    const alternative = (error.details as { alternative?: string } | undefined)?.alternative
    throw new CliError(
      "validation_error",
      `${flag}: "${wanted}" is not a time${alternative ? ` — ${alternative}` : ""}`,
    )
  }
}

export const MINUTE = 60_000
export const YEAR = 365 * 24 * 60 * MINUTE
const RELATIVE = /^(\d+)(m|h|d)$/
const RELATIVE_MS: Record<string, number> = { m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE }
const DATE_ALONE = /^\d{4}-\d{2}-\d{2}$/
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i

export interface Reading {
  time: number
  /** Read in a zone: a date, `today`, or a time without an offset. A relative or offset time is not. */
  local: boolean
  dateAlone: boolean
}

/** `today` or `yesterday` as the date it is in `zone` at `now`. */
const dayWord = (word: string, zone: string, now: number): string => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now)
  if (word === "today") return today
  const date = new Date(`${today}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

/**
 * The shared time grammar: an ISO date or date-time, seconds and zone optional, a space allowed for the `T`; `today`,
 * `yesterday`; or `30m`, `2h`, `7d` counted by `direction` from now. `undefined` when the value has none of these shapes.
 */
export const readMoment = (
  typed: string,
  flag: string,
  { zone, end = false, now = Date.now(), direction = -1 }: MomentZone & { now?: number; direction?: 1 | -1 } = {},
): Reading | undefined => {
  const wanted = typed.trim()
  const [, amount, unit] = RELATIVE.exec(wanted) ?? []
  if (amount && unit)
    return { time: now + direction * Number(amount) * (RELATIVE_MS[unit] ?? 0), local: false, dateAlone: false }
  const word = wanted.toLowerCase()
  const date = word === "today" || word === "yesterday" ? dayWord(word, timezoneOf(zone), now) : wanted
  // By shape: `Date.parse("12345")` is the year 12345, so a message id would pass as a date.
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) return undefined
  const iso = date.replace(/^(\d{4}-\d{2}-\d{2}) +(?=\d)/, "$1T")
  return {
    time: calendarMoment(iso, flag, { ...(zone === undefined ? {} : { zone }), end }),
    local: !ZONED.test(iso),
    dateAlone: DATE_ALONE.test(iso),
  }
}

export interface AheadOptions extends MomentZone {
  /** A date alone has no time of day to act at: sending "on the 20th" means nobody knows when. */
  refuseDate?: boolean
  /** The least lead from now, in ms: 0 refuses the past, a minute is what a messenger schedules at the soonest. */
  soonest?: number
  /** The most lead from now, in ms, where a messenger caps it. */
  latest?: number
}

const lead = (ms: number) => (ms === MINUTE ? "a minute" : ms === YEAR ? "a year" : `${Math.ceil(ms / MINUTE)} minutes`)

/**
 * A time ahead, the one parser of every future flag: the grammar of `readMoment`, relative times counted forward.
 * `none` is not a time; a caller that clears a date checks for it first. The past is allowed unless `soonest` is given.
 */
export const aheadOf = (reference: string, flag: string, now = Date.now(), options: AheadOptions = {}): number => {
  const { refuseDate = false, soonest, latest, ...at } = options
  const read = readMoment(reference, flag, { ...at, now, direction: 1 })
  if (read === undefined)
    throw new CliError(
      "validation_error",
      `${flag} takes an ISO 8601 time, today, or 30m, 2h, 3d from now — not "${reference.trim()}"`,
    )
  if (refuseDate && read.dateAlone)
    throw new CliError(
      "validation_error",
      DATE_ALONE.test(reference.trim())
        ? `${flag} needs a time of day as well: ${reference.trim()}T09:00`
        : `${flag} needs a time of day as well, like 2026-11-20T09:00`,
    )
  if (soonest === 0 && read.time <= now) throw new CliError("validation_error", `${flag} is in the past`)
  if (soonest !== undefined && soonest > 0 && read.time < now + soonest)
    throw new CliError("validation_error", `${flag} has to be at least ${lead(soonest)} from now`)
  if (latest !== undefined && read.time > now + latest)
    throw new CliError("validation_error", `${flag} can be at most ${lead(latest)} from now`)
  return read.time
}
