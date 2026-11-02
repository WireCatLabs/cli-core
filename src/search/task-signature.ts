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

/** Groups of three after a space, a no-break space or a dot (`50 000`, `1.200`) are one number, as Russian texts write sums. */
const NUMBER = String.raw`\d{1,3}(?:[ \u00a0\u202f.]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?`
const AMOUNT = new RegExp(
  String.raw`(?<![\p{L}\p{N}])([$€₽])?\s?(${NUMBER})(?:([кk])(?![\p{L}])|\s?(тыс\.?|тысяч\p{L}*))?(?![\p{N}])\s?(₽|руб\p{L}*\.?|р\.|р(?![\p{L}])|rub|eur|евро|€|\$|usd|долл\p{L}*|dollars?|euros?)?(?![\p{L}])`,
  "gu",
)
const GROUPED = /^\d{1,3}(?:[ \u00a0\u202f.]\d{3})+(?:,\d+)?$/u

const amountValue = (number: string, thousands: boolean): number => {
  const plain = GROUPED.test(number) ? number.replace(/[ \u00a0\u202f.]/gu, "") : number
  return Math.round(Number(plain.replace(",", ".")) * (thousands ? 1000 : 1))
}

/** A bare number is not an amount: `верни 3000 за бензин` has none, so a reminder about it compares as missing. */
export const amountsOf = (text: string): TaskAmount[] => {
  const found: TaskAmount[] = []
  for (const [, before, number = "", short, long, after] of text.matchAll(AMOUNT)) {
    const thousands = (short ?? long) !== undefined
    if (!before && !after && !thousands) continue
    found.push({ value: amountValue(number, thousands), currency: currencyOf(before ?? after?.replace(/\.$/u, "")) })
  }
  return found
}

export const amountOf = (text: string): TaskAmount | null => amountsOf(text)[0] ?? null

const RU_WEEKDAYS = ["воскресен", "понедельник", "вторник", "сред", "четверг", "пятниц", "суббот"]
const EN_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
const ES_WEEKDAYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"]
/** `los viernes` is every Friday, as `по пятницам` and `fridays` are, which are not read either. */
const WEEKDAY_WORDS =
  "понедельник[аеу]?|вторник[аеу]?|сред[аеуы]|четверг[аеу]?|пятниц[аеуы]|суббот[аеуы]|воскресень[еяю]|" +
  `${EN_WEEKDAYS.join("|")}|(?<!los )(?:${ES_WEEKDAYS.join("|")})`
/** Spanish month names only after `<day> de`: on their own, `mayo 2` in an English message would read as May 2. */
const ES_MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "sep?tiembre",
  "octubre",
  "noviembre",
  "diciembre",
]
const MONTHS = [
  /^(январ[ьяею]|jan(uary)?)$/u,
  /^(феврал[ьяею]|feb(ruary)?)$/u,
  /^(март[ауе]?|mar(ch)?)$/u,
  /^(апрел[ьяею]|apr(il)?)$/u,
  /^(ма[яеию]|may)$/u,
  /^(июн[ьяею]|june?)$/u,
  /^(июл[ьяею]|july?)$/u,
  /^(август[ауе]?|aug(ust)?)$/u,
  /^(сентябр[ьяею]|sept?(ember)?)$/u,
  /^(октябр[ьяею]|oct(ober)?)$/u,
  /^(ноябр[ьяею]|nov(ember)?)$/u,
  /^(декабр[ьяею]|dec(ember)?)$/u,
]

const monthIndex = (word: string): number => MONTHS.findIndex((month) => month.test(word))
const esMonth = (word = ""): number => ES_MONTHS.findIndex((month) => new RegExp(`^${month}$`, "u").test(word))

/** The creator's calendar date in the machine's time zone, as a day count: "tomorrow" late at night is local. */
export const dayOf = (ms: number): number => {
  const date = new Date(ms)
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY)
}
const dateDay = (year: number, month: number, day: number) => Math.floor(Date.UTC(year, month, day) / DAY)

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
    ES_WEEKDAYS.indexOf(word),
  )
  let day = now + 1
  while (new Date(day * DAY).getUTCDay() !== target) day++
  return day
}

/** JavaScript's `\b` knows only ASCII letters, so a Cyrillic word needs its edges spelt out. */
const words = (source: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, "gu")

type Resolve = (match: RegExpMatchArray, now: number, year: number) => number | undefined

const ES_DAY = "(3[01]|[12]\\d|0?[1-9])"

const DUE_PATTERNS: [RegExp, Resolve][] = [
  [words("послезавтра|pasado manana"), (_, now) => now + 2],
  // `por la mañana` and `esta mañana` are a morning, not tomorrow.
  [words("завтра|tomorrow|(?<!(?:la|esta|cada|una) )manana"), (_, now) => now + 1],
  [words("сегодня|today|hoy"), (_, now) => now],
  [words("(\\d{1,2})\\.(\\d{2})"), (m, _, year) => dateDay(year, Number(m[2]) - 1, Number(m[1]))],
  [words("(\\d{1,2})(?:st|nd|rd|th)?\\s+(\\p{L}+)"), (m, _, year) => monthDate(year, m[2], m[1])],
  [words("(\\p{L}+)\\.?\\s+(\\d{1,2})"), (m, _, year) => monthDate(year, m[1], m[2])],
  [
    words("(?:до|к|by|until|before|on|deadline)\\s+(?:the\\s+)?(\\d{1,2})(?:-?(?:го|е|числа)|\\s+числа|st|nd|rd|th)"),
    (m, now) => nthDay(Number(m[1]), now),
  ],
  [words(`${ES_DAY}\\s+de\\s+(${ES_MONTHS.join("|")})`), (m, _, year) => dateDay(year, esMonth(m[2]), Number(m[1]))],
  // Spanish has no ordinal suffix, so a bare day counts only when no month follows: `antes del 5 de mayo` is May 5.
  [
    words(
      `(?:(?:antes del|hasta el|para el|el)\\s+dia|antes del|hasta el|para el)\\s+${ES_DAY}(?![.,/]\\d|\\s*%|\\s+del?\\s)`,
    ),
    (m, now) => nthDay(Number(m[1]), now),
  ],
  [words("конца месяца|end of (?:the )?month|fin(?:al)? del? mes"), (_, now) => monthEnd(now)],
  [words(`(${WEEKDAY_WORDS})`), (m, now) => nextWeekday(m[1] ?? "", now)],
]

/**
 * The due day (a local calendar date, as `dayOf` counts it) the earliest date phrase names, read relative to when
 * the task was created; `null` when the text names none. The text is expected normalized (lower case, no diacritics).
 */
export const dueDayOf = (text: string, createdMs: number): number | null => {
  const now = dayOf(createdMs)
  const year = new Date(createdMs).getFullYear()
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
