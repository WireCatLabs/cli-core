import { CliError } from "@wirecat/cli-base"
import { zonedMoment } from "@wirecat/cli-base/query"
import type { EntryStatus, EntryTransparency, ParticipantResponse } from "../meetings/index.js"

/**
 * The part of iCalendar (RFC 5545, https://www.rfc-editor.org/rfc/rfc5545) the calendar commands read and write: one
 * VCALENDAR of VEVENTs, with no VTIMEZONE. Times are written in UTC; a time read with a TZID keeps that zone's name,
 * which the provider takes as it is.
 */
export interface IcsEvent {
  uid: string
  title: string | null
  description?: string | null
  location?: string | null
  /** A timed event, epoch ms, end exclusive. */
  startsAt?: number
  endsAt?: number
  /** An all-day event, `YYYY-MM-DD`, end exclusive. */
  startDate?: string
  endDate?: string
  /** The zone a read time named (`TZID`), or the reader's zone for a floating one. */
  timezone?: string | null
  /** RRULE, RDATE and EXDATE lines, as written. */
  recurrence?: string[]
  status?: EntryStatus | null
  transparency?: EntryTransparency | null
  organizer?: { email: string; name?: string | null } | null
  attendees?: { email: string; name?: string | null; response?: ParticipantResponse | null; optional?: boolean }[]
  url?: string | null
}

const CRLF = "\r\n"
const LINE_OCTETS = 75

const escapeText = (text: string) =>
  text
    .replace(/\\/gu, "\\\\")
    .replace(/;/gu, "\\;")
    .replace(/,/gu, "\\,")
    .replace(/\r\n|\r|\n/gu, "\\n")

/** A parameter value: quoted when it holds `:`, `;` or `,`; a double quote cannot be written in one, so it goes. */
const paramValue = (text: string) => {
  const clean = text.replace(/["\r\n]/gu, "")
  return /[:;,]/u.test(clean) ? `"${clean}"` : clean
}

/** Lines longer than 75 octets go on under a leading space, never splitting a character's UTF-8 bytes. */
export const foldLine = (line: string): string => {
  const parts: string[] = []
  let current = ""
  let octets = 0
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8")
    const room = parts.length === 0 ? LINE_OCTETS : LINE_OCTETS - 1
    if (octets + size > room) {
      parts.push(current)
      current = ""
      octets = 0
    }
    current += char
    octets += size
  }
  parts.push(current)
  return parts.join(`${CRLF} `)
}

const pad = (value: number) => String(value).padStart(2, "0")

const utcStamp = (at: number) => {
  const date = new Date(at)
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  )
}

const dateValue = (date: string) => date.replaceAll("-", "")

const PARTSTAT: Record<ParticipantResponse, string> = {
  "needs-action": "NEEDS-ACTION",
  accepted: "ACCEPTED",
  tentative: "TENTATIVE",
  declined: "DECLINED",
  delegated: "DELEGATED",
}

const eventLines = (event: IcsEvent, stamp: string): string[] => {
  const lines = ["BEGIN:VEVENT", `UID:${escapeText(event.uid)}`, `DTSTAMP:${stamp}`]
  if (event.startDate !== undefined && event.endDate !== undefined)
    lines.push(`DTSTART;VALUE=DATE:${dateValue(event.startDate)}`, `DTEND;VALUE=DATE:${dateValue(event.endDate)}`)
  else if (event.startsAt !== undefined)
    lines.push(`DTSTART:${utcStamp(event.startsAt)}`, `DTEND:${utcStamp(event.endsAt ?? event.startsAt)}`)
  if (event.title) lines.push(`SUMMARY:${escapeText(event.title)}`)
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`)
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`)
  for (const rule of event.recurrence ?? []) lines.push(rule)
  if (event.status) lines.push(`STATUS:${event.status.toUpperCase()}`)
  if (event.transparency) lines.push(`TRANSP:${event.transparency.toUpperCase()}`)
  if (event.organizer)
    lines.push(
      `ORGANIZER${event.organizer.name ? `;CN=${paramValue(event.organizer.name)}` : ""}:mailto:${event.organizer.email}`,
    )
  for (const one of event.attendees ?? []) {
    const params = [
      ...(one.name ? [`CN=${paramValue(one.name)}`] : []),
      ...(one.response ? [`PARTSTAT=${PARTSTAT[one.response]}`] : []),
      ...(one.optional ? ["ROLE=OPT-PARTICIPANT"] : []),
    ]
    lines.push(`ATTENDEE${params.map((param) => `;${param}`).join("")}:mailto:${one.email}`)
  }
  if (event.url) lines.push(`URL:${event.url}`)
  lines.push("END:VEVENT")
  return lines
}

/** One VCALENDAR holding the events, CRLF line ends and folded lines, as RFC 5545 §3.1 asks. */
export const writeIcs = (events: readonly IcsEvent[], options: { now: number; product: string }): string =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//WireCat//${options.product.replace(/[^\w .-]/gu, "")}//EN`,
    "CALSCALE:GREGORIAN",
    ...events.flatMap((event) => eventLines(event, utcStamp(options.now))),
    "END:VCALENDAR",
  ]
    .map(foldLine)
    .join(CRLF)
    .concat(CRLF)

/** One content line, its name upper-cased, its parameters' names upper-cased and their quotes taken off. */
interface ContentLine {
  name: string
  params: Record<string, string>
  value: string
}

const contentLine = (line: string): ContentLine | null => {
  let at = 0
  let quoted = false
  for (; at < line.length; at++) {
    const char = line[at]
    if (char === '"') quoted = !quoted
    else if (char === ":" && !quoted) break
  }
  if (at === line.length) return null
  const head = line.slice(0, at)
  const parts: string[] = []
  let part = ""
  quoted = false
  for (const char of head) {
    if (char === '"') quoted = !quoted
    if (char === ";" && !quoted) {
      parts.push(part)
      part = ""
    } else part += char
  }
  parts.push(part)
  const [name = "", ...rest] = parts
  const params: Record<string, string> = {}
  for (const param of rest) {
    const equals = param.indexOf("=")
    if (equals > 0) params[param.slice(0, equals).toUpperCase()] = param.slice(equals + 1).replace(/^"|"$/gu, "")
  }
  return { name: name.toUpperCase(), params, value: line.slice(at + 1) }
}

const unescapeText = (text: string) =>
  text.replace(/\\([\\;,nN])/gu, (_match, char: string) => (char === "n" || char === "N" ? "\n" : char))

const DATE = /^(\d{4})(\d{2})(\d{2})$/u
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/u

type Moment = { date: string } | { at: number; zone: string | null }

/** A DATE or DATE-TIME: UTC with `Z`, in its TZID, or floating, read in `zone`. */
const momentOf = (line: ContentLine, zone: string): Moment => {
  const value = line.value.trim()
  const date = DATE.exec(value)
  if (date || line.params.VALUE === "DATE") {
    if (!date) throw new Error(`${line.name} ${value} is not a date`)
    return { date: `${date[1]}-${date[2]}-${date[3]}` }
  }
  const time = DATE_TIME.exec(value)
  if (!time) throw new Error(`${line.name} ${value} is not a date or a time`)
  const [, year, month, day, hour, minute, second, utc] = time
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}`
  if (utc) return { at: Date.parse(`${local}Z`), zone: "UTC" }
  const named = line.params.TZID
  const where = named ?? zone
  try {
    return { at: zonedMoment(local, where, { start: 0, end: local.length }), zone: where }
  } catch {
    throw new Error(`${line.name} names the time zone ${where}, which is not an IANA zone such as Europe/Madrid`)
  }
}

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u

const durationMs = (text: string) => {
  const found = DURATION.exec(text.trim())
  if (!found || found[1] === "-") throw new Error(`DURATION ${text} is not a length of time`)
  const [, , weeks, days, hours, minutes, seconds] = found.map((one) => Number(one ?? 0))
  return (
    ((((weeks as number) * 7 + (days as number)) * 24 + (hours as number)) * 60 + (minutes as number)) * 60_000 +
    (seconds as number) * 1000
  )
}

const plusDays = (date: string, days: number) => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

const STATUS: Record<string, EntryStatus> = { CONFIRMED: "confirmed", TENTATIVE: "tentative", CANCELLED: "cancelled" }
const RESPONSE: Record<string, ParticipantResponse> = {
  "NEEDS-ACTION": "needs-action",
  ACCEPTED: "accepted",
  TENTATIVE: "tentative",
  DECLINED: "declined",
  DELEGATED: "delegated",
}

const emailOf = (value: string) => {
  const email = value
    .trim()
    .replace(/^mailto:/iu, "")
    .toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : null
}

/** An event the reader could not take, by its UID when it had one. */
export interface IcsSkip {
  uid: string | null
  reason: string
}

const eventOf = (lines: ContentLine[], zone: string): IcsEvent => {
  const one = (name: string) => lines.find((line) => line.name === name)
  const uid = one("UID")?.value.trim()
  if (!uid) throw new Error("the event has no UID")
  if (one("RECURRENCE-ID"))
    throw new Error("a changed occurrence of a repeating event (RECURRENCE-ID) is not imported on its own")
  const startLine = one("DTSTART")
  if (!startLine) throw new Error("the event has no DTSTART")
  const start = momentOf(startLine, zone)
  const endLine = one("DTEND")
  const duration = one("DURATION")
  const text = (name: string) => {
    const found = one(name)
    return found ? unescapeText(found.value) : null
  }
  const event: IcsEvent = { uid, title: text("SUMMARY") }
  if ("date" in start) {
    const end = endLine ? momentOf(endLine, zone) : undefined
    if (end && !("date" in end)) throw new Error("DTSTART is a date and DTEND a time")
    event.startDate = start.date
    event.endDate =
      end?.date ?? plusDays(start.date, duration ? Math.max(1, Math.ceil(durationMs(duration.value) / 86_400_000)) : 1)
    if (event.endDate <= event.startDate) throw new Error("the event ends before it starts")
  } else {
    const end = endLine ? momentOf(endLine, zone) : undefined
    if (end && "date" in end) throw new Error("DTSTART is a time and DTEND a date")
    event.startsAt = start.at
    event.endsAt = end?.at ?? start.at + (duration ? durationMs(duration.value) : 0)
    event.timezone = start.zone
    if (event.endsAt < event.startsAt) throw new Error("the event ends before it starts")
  }
  const description = text("DESCRIPTION")
  if (description) event.description = description
  const location = text("LOCATION")
  if (location) event.location = location
  const recurrence = lines
    .filter(({ name }) => ["RRULE", "RDATE", "EXDATE"].includes(name))
    .map(({ name, params, value }) => {
      const kept = Object.entries(params).map(([key, param]) => `;${key}=${paramValue(param)}`)
      return `${name}${kept.join("")}:${value.trim()}`
    })
  if (recurrence.length) event.recurrence = recurrence
  const status = STATUS[one("STATUS")?.value.trim().toUpperCase() ?? ""]
  if (status) event.status = status
  const transparency = one("TRANSP")?.value.trim().toUpperCase()
  if (transparency === "TRANSPARENT" || transparency === "OPAQUE")
    event.transparency = transparency === "TRANSPARENT" ? "transparent" : "opaque"
  const organizerLine = one("ORGANIZER")
  const organizer = organizerLine && emailOf(organizerLine.value)
  if (organizerLine && organizer) event.organizer = { email: organizer, name: organizerLine.params.CN ?? null }
  const attendees = lines
    .filter(({ name }) => name === "ATTENDEE")
    .flatMap(({ params, value }) => {
      const email = emailOf(value)
      if (!email) return []
      return [
        {
          email,
          name: params.CN ?? null,
          response: RESPONSE[(params.PARTSTAT ?? "").toUpperCase()] ?? null,
          optional: (params.ROLE ?? "").toUpperCase() === "OPT-PARTICIPANT",
        },
      ]
    })
  if (attendees.length) event.attendees = attendees
  const url = one("URL")?.value.trim()
  if (url) event.url = url
  return event
}

/**
 * The VEVENTs of an iCalendar text; times with neither `Z` nor a TZID are read in `zone`. An event that cannot be
 * imported alone is in `skipped` with the reason; a text with no VCALENDAR is refused.
 */
export const readIcs = (text: string, zone: string): { events: IcsEvent[]; skipped: IcsSkip[] } => {
  const unfolded = text.replace(/^\uFEFF/u, "").replace(/\r?\n[ \t]/gu, "")
  const lines = unfolded.split(/\r?\n/u).filter((line) => line.trim() !== "")
  if (!/^BEGIN:VCALENDAR$/iu.test(lines[0]?.trim() ?? ""))
    throw new CliError("validation_error", "the file is not iCalendar: it does not start with BEGIN:VCALENDAR", {
      reason: "ics.not-icalendar",
    })
  const events: IcsEvent[] = []
  const skipped: IcsSkip[] = []
  let held: ContentLine[] | null = null
  // Components inside a VEVENT, such as VALARM, are passed over whole.
  let inner = 0
  for (const raw of lines) {
    const line = contentLine(raw)
    if (!line) continue
    const value = line.value.trim().toUpperCase()
    if (line.name === "BEGIN" && value === "VEVENT" && held === null) {
      held = []
      continue
    }
    if (held === null) continue
    if (line.name === "BEGIN") inner++
    else if (line.name === "END" && inner > 0) inner--
    else if (line.name === "END" && value === "VEVENT") {
      try {
        events.push(eventOf(held, zone))
      } catch (error) {
        const uid = held.find(({ name }) => name === "UID")?.value.trim() || null
        skipped.push({ uid, reason: error instanceof Error ? error.message : String(error) })
      }
      held = null
    } else if (inner === 0) held.push(line)
  }
  return { events, skipped }
}
