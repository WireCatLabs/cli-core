/**
 * The amount and due date a task's text names, by patterns. Ported from the duplicate test set's scorer
 * (WireCatLabs/cli-testing `performance/tasks/duplicates/evaluate.mjs`); the patterns were written with
 * that set's messages, so they are known to work on those phrasings only.
 */

const DAY = 86_400_000

export type TaskAmount = { value: number; currency: string | null }

const CURRENCY: [RegExp, string][] = [
  [/^(₽|руб.*|р\.?|rub)$/u, "RUB"],
  [/^(€|eur|евро|euros?)$/u, "EUR"],
  [/^(\$|usd|долл.*|dollars?)$/u, "USD"],
]
const currencyOf = (word: string | undefined): string | null =>
  word ? (CURRENCY.find(([pattern]) => pattern.test(word))?.[1] ?? null) : null

const AMOUNT =
  /(?<![\p{L}\p{N}])([$€₽])?\s?(\d+(?:[.,]\d+)?)(?:([кk])(?![\p{L}])|\s?(тыс\.?|тысяч\p{L}*))?(?![\p{N}])\s?(₽|руб\p{L}*\.?|р\.|р(?![\p{L}])|rub|eur|евро|€|\$|usd|долл\p{L}*|dollars?|euros?)?(?![\p{L}])/gu

/** A bare number is not an amount: `верни 3000 за бензин` has none, so a reminder about it compares as missing. */
export const amountOf = (text: string): TaskAmount | null => {
  for (const [, before, number = "", short, long, after] of text.matchAll(AMOUNT)) {
    const multiplier = short ?? long
    if (!before && !after && !multiplier) continue
    const value = Math.round(Number(number.replace(",", ".")) * (multiplier ? 1000 : 1))
    return { value, currency: currencyOf(before ?? after?.replace(/\.$/u, "")) }
  }
  return null
}

const RU_WEEKDAYS = ["воскресен", "понедельник", "вторник", "сред", "четверг", "пятниц", "суббот"]
const EN_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
const RU_MONTHS = [
  "январ",
  "феврал",
  "март",
  "апрел",
  "ма",
  "июн",
  "июл",
  "август",
  "сентябр",
  "октябр",
  "ноябр",
  "декабр",
]
const EN_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

const monthIndex = (word: string): number => {
  const ru = RU_MONTHS.findIndex((stem) => word.startsWith(stem) && (stem !== "ма" || /^ма[яи]$/u.test(word)))
  return ru >= 0 ? ru : EN_MONTHS.findIndex((stem) => word.startsWith(stem))
}

export const dayOf = (ms: number): number => Math.floor(ms / DAY)
const dateDay = (year: number, month: number, day: number) => dayOf(Date.UTC(year, month, day))

const monthDate = (year: number, word = "", day = ""): number | undefined => {
  const month = monthIndex(word)
  return month < 0 || Number(day) > 31 ? undefined : dateDay(year, month, Number(day))
}
const nthDay = (day: number, now: number): number => {
  const date = new Date(now * DAY)
  const sameMonth = dateDay(date.getUTCFullYear(), date.getUTCMonth(), day)
  return sameMonth >= now ? sameMonth : dateDay(date.getUTCFullYear(), date.getUTCMonth() + 1, day)
}
const monthEnd = (now: number): number => {
  const date = new Date(now * DAY)
  return dateDay(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
}
const nextWeekday = (word: string, now: number): number => {
  const target = Math.max(
    RU_WEEKDAYS.findIndex((stem) => word.startsWith(stem)),
    EN_WEEKDAYS.indexOf(word),
  )
  let day = now + 1
  while (new Date(day * DAY).getUTCDay() !== target) day++
  return day
}

type Resolve = (match: RegExpMatchArray, now: number, year: number) => number | undefined

const DUE_PATTERNS: [RegExp, Resolve][] = [
  [/послезавтра/gu, (_, now) => now + 2],
  [/завтра|tomorrow/gu, (_, now) => now + 1],
  [/сегодня|today/gu, (_, now) => now],
  [/\b(\d{1,2})\.(\d{2})\b/gu, (m, _, year) => dateDay(year, Number(m[2]) - 1, Number(m[1]))],
  [/\b(\d{1,2})(?:st|nd|rd|th)?\s+(\p{L}+)/gu, (m, _, year) => monthDate(year, m[2], m[1])],
  [/\b(\p{L}+)\.?\s+(\d{1,2})\b/gu, (m, _, year) => monthDate(year, m[1], m[2])],
  [
    /(?:до|к|by|until|before|on|deadline)\s+(?:the\s+)?(\d{1,2})(?:-?(?:го|е|числа)|\s+числа|st|nd|rd|th)/gu,
    (m, now) => nthDay(Number(m[1]), now),
  ],
  [/конца месяца|end of (?:the )?month/gu, (_, now) => monthEnd(now)],
  [new RegExp(`(${[...RU_WEEKDAYS, ...EN_WEEKDAYS].join("|")})`, "gu"), (m, now) => nextWeekday(m[1] ?? "", now)],
]

/**
 * The due day (whole UTC days since 1970) the earliest date phrase names, read relative to when the task was
 * created; `null` when the text names none. The text is expected normalized (lower case, no diacritics).
 */
export const dueDayOf = (text: string, createdMs: number): number | null => {
  const now = dayOf(createdMs)
  const year = new Date(createdMs).getUTCFullYear()
  let best: { index: number; day: number } | undefined
  for (const [pattern, resolve] of DUE_PATTERNS)
    for (const match of text.matchAll(pattern)) {
      const day = resolve(match, now, year)
      if (day === undefined || Number.isNaN(day)) continue
      if (!best || (match.index ?? 0) < best.index) best = { index: match.index ?? 0, day }
      break
    }
  return best?.day ?? null
}
