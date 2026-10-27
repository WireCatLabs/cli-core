import { CliError } from "@wirecat/cli-base"

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
