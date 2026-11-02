import type { EntryInput } from "../meetings/index.js"
import type { SyncWindow } from "./source.js"

const DAY = 86_400_000
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
const FREQUENCIES = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"])
const PARTS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "WKST"])
const BY_DAY = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/u
const STAMP = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/u
/** A runaway rule (FREQ=DAILY from 1900) still ends: the window's end stops it long before this. */
const MOST_PERIODS = 200_000

interface Rule {
  freq: string
  interval: number
  count?: number
  until?: string
  byDay?: { nth: number | null; day: number }[]
  byMonthDay?: number[]
  byMonth?: number[]
  bySetPos?: number[]
  wkst: number
}

const numbers = (text: string, low: number, high: number) => {
  const values = text.split(",").map(Number)
  return values.every((one) => Number.isInteger(one) && one !== 0 && Math.abs(one) >= low && Math.abs(one) <= high)
    ? values
    : undefined
}

/** RFC 5545 §3.3.10 as far as calendar feeds use it; anything else is a reason, never a guess. */
const ruleOf = (line: string): Rule | string => {
  const parts = new Map<string, string>()
  for (const part of line.replace(/^RRULE:/iu, "").split(";")) {
    const [key = "", value = ""] = part.split("=")
    parts.set(key.trim().toUpperCase(), value.trim().toUpperCase())
  }
  for (const key of parts.keys()) if (!PARTS.has(key)) return `RRULE part ${key} is not expanded`
  const freq = parts.get("FREQ") ?? ""
  if (!FREQUENCIES.has(freq)) return `RRULE FREQ=${freq} is not expanded`
  const rule: Rule = { freq, interval: Number(parts.get("INTERVAL") ?? 1), wkst: 1 }
  if (!Number.isInteger(rule.interval) || rule.interval < 1) return "RRULE INTERVAL is not a whole number from 1"
  if (parts.has("COUNT")) {
    rule.count = Number(parts.get("COUNT"))
    if (!Number.isInteger(rule.count) || rule.count < 1) return "RRULE COUNT is not a whole number from 1"
  }
  if (parts.has("UNTIL")) rule.until = parts.get("UNTIL")
  const days = parts.get("BYDAY")
  if (days !== undefined) {
    rule.byDay = []
    for (const day of days.split(",")) {
      const found = BY_DAY.exec(day)
      if (!found) return `RRULE BYDAY ${day} is not a day`
      rule.byDay.push({ nth: found[1] ? Number(found[1]) : null, day: WEEKDAYS.indexOf(found[2] as string) })
    }
  }
  for (const [key, field, high] of [
    ["BYMONTHDAY", "byMonthDay", 31],
    ["BYMONTH", "byMonth", 12],
    ["BYSETPOS", "bySetPos", 366],
  ] as const) {
    const text = parts.get(key)
    if (text === undefined) continue
    const values = numbers(text, 1, high)
    if (!values || (key === "BYMONTH" && values.some((one) => one < 0))) return `RRULE ${key}=${text} is not expanded`
    rule[field] = values
  }
  const wkst = parts.get("WKST")
  if (wkst !== undefined) {
    if (!WEEKDAYS.includes(wkst)) return `RRULE WKST=${wkst} is not a day`
    rule.wkst = WEEKDAYS.indexOf(wkst)
  }
  return rule
}

const formatters = new Map<string, Intl.DateTimeFormat>()

const formatterOf = (zone: string) => {
  let formatter = formatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
    formatters.set(zone, formatter)
  }
  return formatter
}

/** The wall clock in `zone` at `at`, as `YYYY-MM-DD` and `HH:MM:SS`. */
const wallClock = (at: number, zone: string) => {
  const parts = Object.fromEntries(
    formatterOf(zone)
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  )
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` }
}

const offsetAt = (at: number, zone: string) => {
  const { date, time } = wallClock(at, zone)
  return Date.parse(`${date}T${time}Z`) - Math.floor(at / 1000) * 1000
}

/**
 * A wall-clock time in `zone` as epoch ms. A time a clock change skips is read with the offset before the change, so it
 * lands after it, and a repeated one takes its first moment (RFC 5545 §3.3.5): a slot is moved, never dropped.
 */
export const localMoment = (date: string, time: string, zone: string): number => {
  const guess = Date.parse(`${date}T${time}Z`)
  const before = guess - offsetAt(guess - DAY / 2, zone)
  const after = guess - offsetAt(guess + DAY / 2, zone)
  const exact = [before, after].filter((at) => {
    const shown = wallClock(at, zone)
    return shown.date === date && shown.time === time
  })
  return exact.length === 2 ? Math.min(before, after) : (exact[0] ?? before)
}

const plusDays = (date: string, days: number) => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

const dayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()
const pad = (value: number) => String(value).padStart(2, "0")
const dateOf = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY)

/** The days of a set that BYDAY names: every such weekday, or with a number the nth of them, from the end if negative. */
const pickDays = (all: string[], byDay: NonNullable<Rule["byDay"]>) =>
  byDay.flatMap(({ nth, day }) => {
    const matching = all.filter((date) => dayOf(date) === day)
    if (nth === null) return matching
    const picked = nth > 0 ? matching[nth - 1] : matching[matching.length + nth]
    return picked ? [picked] : []
  })

const monthDays = (year: number, month: number) =>
  Array.from({ length: daysIn(year, month) }, (_, n) => dateOf(year, month, n + 1))

const byMonthDay = (year: number, month: number, days: number[]) =>
  days.flatMap((day) => {
    const size = daysIn(year, month)
    const at = day > 0 ? day : size + day + 1
    return at >= 1 && at <= size ? [dateOf(year, month, at)] : []
  })

/** One month's days under BYMONTHDAY and BYDAY, or the start's day of the month without either. */
const inMonth = (year: number, month: number, rule: Rule, startDay: number) => {
  const byDays = rule.byDay ? pickDays(monthDays(year, month), rule.byDay) : undefined
  const byDates = rule.byMonthDay ? byMonthDay(year, month, rule.byMonthDay) : undefined
  if (byDays && byDates) return byDates.filter((date) => byDays.includes(date))
  if (byDays) return byDays
  if (byDates) return byDates
  return startDay <= daysIn(year, month) ? [dateOf(year, month, startDay)] : []
}

const setPos = (dates: string[], positions: number[] | undefined) => {
  if (!positions) return dates
  return positions.flatMap((at) => {
    const picked = at > 0 ? dates[at - 1] : dates[dates.length + at]
    return picked ? [picked] : []
  })
}

const sorted = (dates: string[]) => [...new Set(dates)].sort()

/** The candidate dates of the nth period of the rule, in order. */
const periodDates = (rule: Rule, start: string, n: number): string[] => {
  const [year, month, day] = start.split("-").map(Number) as [number, number, number]
  const step = n * rule.interval
  const inMonths = (dates: string[]) =>
    rule.byMonth ? dates.filter((date) => rule.byMonth?.includes(Number(date.slice(5, 7)))) : dates
  if (rule.freq === "DAILY") {
    const date = plusDays(start, step)
    const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))]
    if (rule.byMonthDay && !byMonthDay(y, m, rule.byMonthDay).includes(date)) return []
    if (rule.byDay && !rule.byDay.some(({ day: weekday }) => weekday === dayOf(date))) return []
    return inMonths([date])
  }
  if (rule.freq === "WEEKLY") {
    const weekStart = plusDays(plusDays(start, -((dayOf(start) - rule.wkst + 7) % 7)), 7 * step)
    const days = rule.byDay ? rule.byDay.map(({ day: weekday }) => weekday) : [dayOf(start)]
    const dates = days.map((weekday) => plusDays(weekStart, (weekday - rule.wkst + 7) % 7))
    return setPos(sorted(inMonths(dates)), rule.bySetPos)
  }
  if (rule.freq === "MONTHLY") {
    const total = month - 1 + step
    const [y, m] = [year + Math.floor(total / 12), (total % 12) + 1]
    if (rule.byMonth && !rule.byMonth.includes(m)) return []
    return setPos(sorted(inMonth(y, m, rule, day)), rule.bySetPos)
  }
  const y = year + step
  if (!rule.byMonth && rule.byDay && !rule.byMonthDay) {
    const all = Array.from({ length: 12 }, (_, at) => monthDays(y, at + 1)).flat()
    return setPos(sorted(pickDays(all, rule.byDay)), rule.bySetPos)
  }
  const months = rule.byMonth ?? (rule.byMonthDay ? Array.from({ length: 12 }, (_, at) => at + 1) : [month])
  return setPos(sorted(months.flatMap((m) => inMonth(y, m, rule, day))), rule.bySetPos)
}

/** The first day of the nth period, so a rule that matches no day still stops at the window's end. */
const periodStart = (rule: Rule, start: string, n: number) => {
  const step = n * rule.interval
  if (rule.freq === "DAILY") return plusDays(start, step)
  if (rule.freq === "WEEKLY") return plusDays(start, 7 * step - ((dayOf(start) - rule.wkst + 7) % 7))
  const [year, month] = start.split("-").map(Number) as [number, number]
  if (rule.freq === "YEARLY") return dateOf(year + step, 1, 1)
  const total = month - 1 + step
  return dateOf(year + Math.floor(total / 12), (total % 12) + 1, 1)
}

/** A DATE or DATE-TIME of UNTIL, EXDATE or RDATE: `date` always, `at` for a time; floating times are read in `zone`. */
const stampOf = (text: string, zone: string, tzid?: string): { date: string; at?: number } | undefined => {
  const found = STAMP.exec(text.trim())
  if (!found) return undefined
  const [, year, month, day, hour, minute, second, utc] = found
  const date = `${year}-${month}-${day}`
  if (hour === undefined) return { date }
  const time = `${hour}:${minute}:${second}`
  return { date, at: utc ? Date.parse(`${date}T${time}Z`) : localMoment(date, time, tzid ?? zone) }
}

/** The values of every `EXDATE` or `RDATE` line, with its TZID; a PERIOD's start stands for it. */
const listed = (lines: readonly string[], name: string, zone: string) =>
  lines
    .filter((line) => line.toUpperCase().startsWith(name))
    .flatMap((line) => {
      const colon = line.indexOf(":")
      const tzid = /;TZID=([^;:]+)/iu.exec(line.slice(0, colon))?.[1]?.replace(/^"|"$/gu, "")
      return line
        .slice(colon + 1)
        .split(",")
        .map((value) => stampOf(value.split("/")[0] ?? "", zone, tzid))
        .filter((one) => one !== undefined)
    })

/** Why a series cannot be expanded here, or `null` when it can. */
export const unexpandable = (recurrence: readonly string[] | null | undefined): string | null => {
  const rules = (recurrence ?? []).filter((line) => /^RRULE[:;]/iu.test(line))
  if ((recurrence ?? []).some((line) => /^EXRULE[:;]/iu.test(line))) return "EXRULE is not expanded"
  if (rules.length > 1) return "more than one RRULE is not expanded"
  const [line] = rules
  if (line === undefined) return null
  const rule = ruleOf(line)
  return typeof rule === "string" ? rule : null
}

const utcStamp = (at: number) =>
  new Date(at)
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "")

/**
 * The slots of a series inside the window, as occurrences: its RRULE, plus RDATE, less EXDATE, which come back
 * `cancelled` so a stored slot is cancelled. Times repeat in the series' own zone, so a weekly 10:00 stays 10:00
 * across a clock change. An override (an iCalendar RECURRENCE-ID) takes the place of the slot it names.
 */
export const expandSeries = (
  series: EntryInput,
  window: SyncWindow,
  overrides: readonly (EntryInput & { originalStartsAt: number })[] = [],
): EntryInput[] => {
  const recurrence = series.recurrence ?? []
  if (unexpandable(recurrence) !== null || series.startsAt == null) return []
  const zone = series.timezone ?? "UTC"
  const allDay = series.allDay === true && typeof series.startDate === "string"
  const start = allDay ? (series.startDate as string) : wallClock(series.startsAt, zone).date
  const time = allDay ? "00:00:00" : wallClock(series.startsAt, zone).time
  const length = (series.endsAt ?? series.startsAt) - series.startsAt
  const days = allDay && series.endDate ? Math.max(1, daysBetween(start, series.endDate)) : 1
  const line = recurrence.find((one) => /^RRULE[:;]/iu.test(one))
  const rule = line === undefined ? undefined : (ruleOf(line) as Rule)
  const until = rule?.until === undefined ? undefined : stampOf(rule.until, zone)
  const momentOf = (date: string) => (allDay ? localMoment(date, "00:00:00", zone) : localMoment(date, time, zone))
  const past = (date: string, at: number) =>
    until !== undefined && (allDay || until.at === undefined ? date > until.date : at > (until.at as number))

  const dates: { date: string; at: number }[] = [{ date: start, at: series.startsAt }]
  if (rule) {
    let count = 1
    outer: for (let n = 0; n < MOST_PERIODS; n++) {
      if (Date.parse(periodStart(rule, start, n)) > window.to + DAY) break
      for (const date of periodDates(rule, start, n)) {
        if (date <= start) continue
        const at = momentOf(date)
        if (past(date, at) || (rule.count !== undefined && count >= rule.count) || at >= window.to) break outer
        dates.push({ date, at })
        count++
      }
    }
  }
  for (const extra of listed(recurrence, "RDATE", zone)) {
    const at = allDay ? momentOf(extra.date) : (extra.at ?? momentOf(extra.date))
    if (!dates.some((one) => one.at === at)) dates.push({ date: extra.date, at })
  }
  const excluded = listed(recurrence, "EXDATE", zone)
  const isExcluded = ({ date, at }: { date: string; at: number }) =>
    excluded.some((one) => (allDay || one.at === undefined ? one.date === date : one.at === at))

  const originalOf = ({ date, at }: { date: string; at: number }) => (allDay ? Date.parse(`${date}T00:00:00Z`) : at)
  const replaced = new Map(overrides.map((one) => [one.originalStartsAt, one]))
  const inWindow = (entry: EntryInput) =>
    entry.startsAt != null &&
    entry.startsAt < window.to &&
    Math.max(entry.endsAt ?? entry.startsAt, entry.startsAt + 1) > window.from
  const slotId = (original: number) =>
    `${series.externalId}_${allDay ? new Date(original).toISOString().slice(0, 10).replaceAll("-", "") : utcStamp(original)}`
  const slots: EntryInput[] = []
  for (const one of dates.sort((a, b) => a.at - b.at)) {
    const original = originalOf(one)
    const override = replaced.get(original)
    replaced.delete(original)
    const cancelled = isExcluded(one)
    const base = override && !cancelled ? override : series
    const endDate = allDay ? plusDays(one.date, days) : null
    const slot: EntryInput = {
      ...base,
      externalId: slotId(original),
      kind: "occurrence",
      seriesExternalId: series.externalId,
      originalStartsAt: original,
      exception: cancelled || override !== undefined,
      status: cancelled ? "cancelled" : (base.status ?? "confirmed"),
      recurrence: null,
      etag: null,
      ...(override && !cancelled
        ? {}
        : {
            startsAt: one.at,
            endsAt: allDay ? momentOf(endDate as string) : one.at + length,
            startDate: allDay ? one.date : null,
            endDate,
          }),
    }
    if (inWindow(slot)) slots.push(slot)
  }
  for (const [original, override] of replaced) {
    const slot: EntryInput = {
      ...override,
      externalId: slotId(original),
      kind: "occurrence",
      seriesExternalId: series.externalId,
      originalStartsAt: original,
      exception: true,
      recurrence: null,
      etag: null,
    }
    if (inWindow(slot)) slots.push(slot)
  }
  return slots
}
