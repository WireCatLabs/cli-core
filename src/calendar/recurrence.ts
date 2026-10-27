import { CliError } from "@wirecat/cli-base"
import { zonedMoment } from "@wirecat/cli-base/query"

const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY"]
const ORDER = ["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL"]
const DAY = /^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/u
const POSITIVE = /^[1-9]\d{0,3}$/u
const UNTIL_DATE = /^(\d{4})(\d{2})(\d{2})$/u
const UNTIL_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u

export const REPEAT_HELP =
  "an RFC 5545 rule: FREQ=DAILY|WEEKLY|MONTHLY, and INTERVAL, BYDAY (MO,WE; in MONTHLY also 1MO or -1FR), " +
  "COUNT or UNTIL (a date, YYYYMMDD, for an all-day event; a UTC time, YYYYMMDDTHHMMSSZ, for a timed one)"

const refuse = (problem: string) =>
  new CliError("validation_error", `${problem}; a repeat rule is ${REPEAT_HELP}`, { reason: "event.repeat-invalid" })

const realDate = (year: string, month: string, day: string) =>
  new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).toISOString().slice(0, 10) ===
  `${year}-${month}-${day}`

/**
 * The subset of RFC 5545 (§3.3.10) every calendar provider takes, as its one `RRULE:` line in a fixed part order.
 * UNTIL must have the type of the event's start (§3.3.10: DATE with DATE, UTC DATE-TIME with DATE-TIME).
 */
export const repeatRule = (text: string, { allDay }: { allDay: boolean }): string => {
  const body = text.trim().replace(/^RRULE:/iu, "")
  if (!body) throw refuse("the rule is empty")
  const parts = new Map<string, string>()
  for (const part of body.split(";")) {
    const [key = "", value, ...rest] = part.split("=")
    const name = key.trim().toUpperCase()
    if (value === undefined || rest.length || !value.trim()) throw refuse(`${part} is not KEY=VALUE`)
    if (!ORDER.includes(name)) throw refuse(`${name} is not taken`)
    if (parts.has(name)) throw refuse(`${name} is given twice`)
    parts.set(name, value.trim().toUpperCase())
  }
  const frequency = parts.get("FREQ")
  if (!frequency || !FREQUENCIES.includes(frequency)) throw refuse("FREQ is DAILY, WEEKLY or MONTHLY")
  for (const name of ["INTERVAL", "COUNT"])
    if (parts.has(name) && !POSITIVE.test(parts.get(name) as string)) throw refuse(`${name} is a whole number from 1`)
  if (parts.has("COUNT") && parts.has("UNTIL")) throw refuse("COUNT and UNTIL do not go together")
  const days = parts.get("BYDAY")
  if (days !== undefined)
    for (const day of days.split(",")) {
      const found = DAY.exec(day)
      if (!found) throw refuse(`${day} is not a day: MO, TU, WE, TH, FR, SA or SU`)
      if (found[1] && frequency !== "MONTHLY") throw refuse(`${day} counts weeks, which only MONTHLY does`)
    }
  const until = parts.get("UNTIL")
  if (until !== undefined) {
    const match = (allDay ? UNTIL_DATE : UNTIL_TIME).exec(until)
    if (!match || !realDate(match[1] as string, match[2] as string, match[3] as string))
      throw refuse(
        allDay
          ? `UNTIL of an all-day event is a date, YYYYMMDD`
          : `UNTIL of a timed event is a UTC time, YYYYMMDDTHHMMSSZ`,
      )
    if (!allDay && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59))
      throw refuse(`${until} is not a time`)
  }
  return `RRULE:${ORDER.filter((name) => parts.has(name))
    .map((name) => `${name}=${parts.get(name)}`)
    .join(";")}`
}

/** UNTIL, EXDATE and RDATE carry a date or a time, so they no longer fit once the event switches between the two. */
export const kindBoundLines = (lines: readonly string[]) =>
  lines.filter((line) => /^(EXDATE|RDATE)[:;]/iu.test(line) || /^RRULE:.*UNTIL=/iu.test(line))

const RULE_LINE = /^RRULE:/iu
const VALUE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/u
const DAY_MS = 86_400_000

const partsOf = (rule: string) => rule.replace(RULE_LINE, "").split(";").filter(Boolean)
const partOf = (rule: string, name: string) =>
  partsOf(rule)
    .find((part) => part.toUpperCase().startsWith(`${name}=`))
    ?.slice(name.length + 1)

/**
 * The instant one RFC 5545 date or date-time names (§3.3.4, §3.3.5): a date is midnight UTC, as an all-day slot is
 * stored; a time without `Z` is read in its `TZID`, or in the series' zone when it floats.
 */
const instantOf = (value: string, zone: string): number | undefined => {
  const found = VALUE.exec(value.trim().toUpperCase())
  if (!found) return undefined
  const [, year, month, day, hour, minute, second, utc] = found
  if (hour === undefined) return Date.UTC(Number(year), Number(month) - 1, Number(day))
  if (utc) return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  const wall = `${year}-${month}-${day}T${hour}:${minute}:${second}`
  try {
    return zonedMoment(wall, zone, { start: 0, end: wall.length })
  } catch {
    return undefined
  }
}

/** The series' rule line, or `undefined` for one that repeats only by RDATE. */
export const ruleLine = (lines: readonly string[]) => lines.find((line) => RULE_LINE.test(line))

export const ruleCount = (rule: string) => partOf(rule, "COUNT")

/** When the rule's UNTIL ends it, or `undefined` while it has none. */
export const ruleEnd = (rule: string, zone: string) => {
  const until = partOf(rule, "UNTIL")
  return until === undefined ? undefined : instantOf(until, zone)
}

/**
 * The same rule ending just before `at`: UNTIL is inclusive (RFC 5545 §3.3.10), so a timed series ends one second
 * before and an all-day one the day before. COUNT gives way to UNTIL, which keeps exactly the slots before `at`.
 */
export const ruleEndingBefore = (rule: string, at: number, { allDay }: { allDay: boolean }) => {
  const until = allDay
    ? new Date(at - DAY_MS).toISOString().slice(0, 10).replaceAll("-", "")
    : `${new Date(at - 1000).toISOString().slice(0, 19).replaceAll(/[-:]/gu, "")}Z`
  const kept = partsOf(rule).filter((part) => !/^(COUNT|UNTIL)=/iu.test(part))
  return `RRULE:${[...kept, `UNTIL=${until}`].join(";")}`
}

/**
 * EXDATE and RDATE lines split at `at`: the dates before stay with the old series, the rest go with the new one, so
 * an occurrence the owner removed does not come back. A value this cannot read, such as an RDATE period, refuses.
 */
export const splitDates = (lines: readonly string[], at: number, zone: string) => {
  const before: string[] = []
  const after: string[] = []
  for (const line of lines.filter((one) => /^(EXDATE|RDATE)[:;]/iu.test(one))) {
    const colon = line.indexOf(":")
    const head = line.slice(0, colon)
    const tzid = /;TZID=([^;:]+)/iu.exec(head)?.[1]
    const early: string[] = []
    const late: string[] = []
    for (const value of line.slice(colon + 1).split(",")) {
      const instant = instantOf(value, tzid ?? zone)
      if (instant === undefined)
        throw new CliError(
          "validation_error",
          `the series holds ${head}:${value}, which cannot be split here; change it in the calendar itself`,
          { reason: "event.repeat-split" },
        )
      ;(instant < at ? early : late).push(value)
    }
    if (early.length) before.push(`${head}:${early.join(",")}`)
    if (late.length) after.push(`${head}:${late.join(",")}`)
  }
  return { before, after }
}
