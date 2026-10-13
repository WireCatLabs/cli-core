import { queryError, type Span } from "./types.js"

export const timezoneOf = (given?: string): string => {
  const zone = given ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0)
  } catch {
    queryError("query.invalid-timezone", { start: 0, end: 0 }, "use an IANA timezone such as Europe/Madrid")
  }
  return zone
}
const calendar = (value: string, span: Span) => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value))
    queryError("query.invalid-date", span, "use an ISO date or a quoted timestamp with offset")
  const year = Number(value.slice(0, 4)),
    month = Number(value.slice(5, 7)),
    day = Number(value.slice(8, 10))
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    queryError("query.invalid-date", span)
  return date
}
export const dayBoundary = (value: string, zone: string, next: boolean, span: Span): number => {
  const date = calendar(value, span)
  if (next) date.setUTCDate(date.getUTCDate() + 1)
  const wanted = date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate()
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    era: "short",
  })
  const dayAt = (time: number) => {
    const parts = formatter.formatToParts(time)
    const value = (name: string) => Number(parts.find((p) => p.type === name)?.value)
    const year = parts.find((p) => p.type === "era")?.value === "BC" ? 1 - value("year") : value("year")
    return year * 10000 + value("month") * 100 + value("day")
  }
  let lo = date.getTime() - 2 * 86_400_000,
    hi = date.getTime() + 2 * 86_400_000
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (dayAt(mid) < wanted) lo = mid + 1
    else hi = mid
  }
  if (dayAt(lo) !== wanted)
    queryError("query.invalid-date", span, "this calendar day does not exist in the selected timezone")
  return lo
}
const AGO = /^(\d+)(m|h|d)$/u
const AGO_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const dayOf = (word: string, zone: string, now: number, span: Span): string => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
  if (word === "today") return today
  const date = calendar(today, span)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}
export interface DateRange {
  lower?: number
  upper?: number
  lowerInclusive: boolean
  upperInclusive: boolean
}
export const dateEndpoint = (
  value: string,
  zone: string,
  side: "lower" | "upper",
  inclusive: boolean,
  span: Span,
  now = Date.now(),
): { time?: number; inclusive: boolean } => {
  if (value === "*") return { inclusive }
  const word = value.toLowerCase()
  if (word === "today" || word === "yesterday")
    return dateEndpoint(dayOf(word, zone, now, span), zone, side, inclusive, span)
  const [, amount, unit] = AGO.exec(word) ?? []
  if (amount && unit) return { time: now - Number(amount) * (AGO_MS[unit] ?? 0), inclusive }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return {
      time: dayBoundary(value, zone, side === "lower" ? !inclusive : inclusive, span),
      inclusive: side === "lower",
    }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value))
    queryError(
      "query.invalid-date",
      span,
      "use an ISO date, today, yesterday, 30m/2h/7d ago, or a quoted timestamp with offset",
    )
  calendar(value.slice(0, 10), span)
  const time = Date.parse(value)
  if (
    !Number.isFinite(time) ||
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    queryError("query.invalid-date", span)
  return { time, inclusive }
}
export const dateRange = (
  lower: string,
  upper: string,
  lowerInclusive: boolean,
  upperInclusive: boolean,
  zone: string,
  span: Span,
  now = Date.now(),
): DateRange => {
  const since = lower === upper && AGO.test(lower.toLowerCase())
  const lo = dateEndpoint(lower, zone, "lower", lowerInclusive, span, now)
  const hi = dateEndpoint(since ? "*" : upper, zone, "upper", upperInclusive, span, now)
  return {
    ...(lo.time === undefined ? {} : { lower: lo.time }),
    ...(hi.time === undefined ? {} : { upper: hi.time }),
    lowerInclusive: lo.inclusive,
    upperInclusive: hi.inclusive,
  }
}
