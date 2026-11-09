import { dayBoundary } from "@wirecat/cli-base/query"

/** The time a question asks about, as epoch ms: `from` is the start of its first local day, `to` of the day after it. */
export interface Period {
  from: number
  to: number
}

const DAY = 86_400_000
const SPAN = { start: 0, end: 0 }
/** A calendar day as the UTC midnight of that date: plain date arithmetic, read in the zone only at the end. */
type Days = [first: number, last: number]

// `\b` knows only ASCII letters, so Russian words need their own edges.
const phrase = (source: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, "giu")

const MONTHS = [
  /january|январ\p{L}*/u,
  /february|феврал\p{L}*/u,
  /march|март\p{L}*/u,
  /april|апрел\p{L}*/u,
  /may|ма[йяе]/u,
  /june|июн\p{L}*/u,
  /july|июл\p{L}*/u,
  /august|август\p{L}*/u,
  /september|сентябр\p{L}*/u,
  /october|октябр\p{L}*/u,
  /november|ноябр\p{L}*/u,
  /december|декабр\p{L}*/u,
]
const MONTH = MONTHS.map(({ source }) => source).join("|")
const ORDINAL = "(?:st|nd|rd|th)?"
const DATED_MONTH = phrase(
  `(?:(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?)?(${MONTH})(?:\\s+(\\d{1,2})${ORDINAL}(?!\\p{N}))?(?:,?\\s+(\\d{4}))?`,
)
// "May I…" and "it may" are not the month; "in May", "May 5" and "May 2025" are.
const MONTH_BEFORE_MAY = /(?:in|of|since|during|until|by|early|late|mid|from|through)\s+$/iu

const monthOf = (name: string) => MONTHS.findIndex(({ source }) => new RegExp(`^(?:${source})$`, "iu").test(name))
const monthDays = (year: number, month: number): Days => [Date.UTC(year, month, 1), Date.UTC(year, month + 1, 0)]
const weekDays = (day: number): Days => {
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7
  return [day - sinceMonday * DAY, day + (6 - sinceMonday) * DAY]
}
const yearDays = (year: number): Days => [Date.UTC(year, 0, 1), Date.UTC(year, 11, 31)]

const unitDays = (unit: string, day: number): Days => {
  const at = new Date(day)
  if (/^(?:day|дн|день)/iu.test(unit)) return [day, day]
  if (/^(?:week|недел)/iu.test(unit)) return weekDays(day)
  if (/^(?:month|месяц)/iu.test(unit)) return monthDays(at.getUTCFullYear(), at.getUTCMonth())
  return yearDays(at.getUTCFullYear())
}

const unitsBack = (unit: string, count: number, today: number): number => {
  const at = new Date(today)
  if (/^(?:day|дн|день)/iu.test(unit)) return today - count * DAY
  if (/^(?:week|недел)/iu.test(unit)) return today - 7 * count * DAY
  if (/^(?:month|месяц)/iu.test(unit)) return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - count, 1)
  return Date.UTC(at.getUTCFullYear() - count, 0, 1)
}

/** `part(n)` is the match's group n, "" when it did not take part. */
type Rule = [RegExp, (part: (n: number) => string, today: number, match: RegExpExecArray) => Days | undefined]

const RULES: Rule[] = [
  [
    /(?<!\p{N})(\d{4})-(\d{2})-(\d{2})(?!\p{N})/gu,
    (part) => {
      const day = Date.UTC(Number(part(1)), Number(part(2)) - 1, Number(part(3)))
      return [day, day]
    },
  ],
  [phrase("today|tonight|сегодня"), (_, today) => [today, today]],
  [phrase("yesterday|вчера"), (_, today) => [today - DAY, today - DAY]],
  [phrase("позавчера"), (_, today) => [today - 2 * DAY, today - 2 * DAY]],
  [
    phrase(
      /(\d+|an?|one)\s+(days?|weeks?|months?|years?)\s+ago|(\d+)\s+(дн\p{L}*|день|недел\p{L}*|месяц\p{L}*|год\p{L}*|лет)\s+назад/u
        .source,
    ),
    (part, today) => {
      const n = Number.parseInt(part(1) || part(3), 10) || 1
      const word = part(2) || part(4)
      return unitDays(word, unitsBack(word, n, today))
    },
  ],
  [
    phrase("(?:last|past)\\s+(\\d+)\\s+days|(?:последние|за\\s+последние)\\s+(\\d+)\\s+дн\\p{L}*"),
    (part, today) => [today - (Number(part(1) || part(2)) - 1) * DAY, today],
  ],
  [
    phrase("(last|past|previous|this)\\s+(week|weekend|month|year)"),
    (part, today) => {
      const last = part(1).toLowerCase() !== "this"
      const unit = part(2)
      if (unit.toLowerCase() === "weekend") {
        const [monday] = weekDays(last ? today - 7 * DAY : today)
        return [monday + 5 * DAY, monday + 6 * DAY]
      }
      return unitDays(unit, last ? unitsBack(unit, 1, today) : today)
    },
  ],
  [
    phrase(/(?:на|в)\s+(прошл|эт)\p{L}*\s+(недел\p{L}*|месяц\p{L}*|год\p{L}*)/u.source),
    (part, today) => unitDays(part(2), part(1).toLowerCase() === "эт" ? today : unitsBack(part(2), 1, today)),
  ],
  [
    DATED_MONTH,
    (part, today, match) => {
      const [name, year] = [part(2), part(4)]
      const day = Number(part(1) || part(3) || 0)
      if (/^may$/iu.test(name) && !day && !year && !MONTH_BEFORE_MAY.test(match.input.slice(0, match.index))) return
      const month = monthOf(name)
      const now = new Date(today)
      // A month without a year is its last one up to today: asked in March, "December" is last December.
      const lastYear = month > now.getUTCMonth() || (month === now.getUTCMonth() && day > now.getUTCDate())
      const y = year ? Number(year) : now.getUTCFullYear() - (lastYear ? 1 : 0)
      const [first, last] = monthDays(y, month)
      if (!day || day > new Date(last).getUTCDate()) return [first, last]
      return [Date.UTC(y, month, day), Date.UTC(y, month, day)]
    },
  ],
]

/**
 * The period a question names — a date, a month, "last week", «в прошлом месяце» — from the first day any phrase names
 * to the last; undefined when it names none. Read as `zone`'s calendar on `now`.
 */
export const questionPeriod = (text: string, now: number, zone: string): Period | undefined => {
  const today = Date.parse(`${new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now)}T00:00:00Z`)
  const found: Days[] = []
  for (const [pattern, days] of RULES)
    for (const match of text.matchAll(pattern)) {
      const span = days((n) => match[n] ?? "", today, match as RegExpExecArray)
      if (span) found.push(span)
    }
  // "In March this year" means March: a span that holds another one named beside it only gives that one its year.
  const inner = found.filter(
    ([first, last]) => !found.some(([f, l]) => f >= first && l <= last && l - f < last - first),
  )
  if (!inner.length) return
  const iso = (day: number) => new Date(day).toISOString().slice(0, 10)
  return {
    from: dayBoundary(iso(inner.reduce((min, [first]) => Math.min(min, first), Infinity)), zone, false, SPAN),
    to: dayBoundary(iso(inner.reduce((max, [, last]) => Math.max(max, last), -Infinity)), zone, true, SPAN),
  }
}
