import { renderPretty } from "@wirecat/cli-base"

const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A calendar answer as a person reads it at a terminal (WC-TIME-4): each UTC time on the wall clock of `zone`, an
 * all-day event's times as its local dates, and a last line naming the zone. JSON keeps the UTC times.
 */
export const localTimesView = (value: unknown, zone: string, color: boolean): string => {
  const clock = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  let shown = false
  const local = (text: string, dateOnly: boolean) => {
    const part = Object.fromEntries(clock.formatToParts(Date.parse(text)).map(({ type, value }) => [type, value]))
    shown = true
    const date = `${part.year}-${part.month}-${part.day}`
    return dateOnly ? date : `${date} ${part.hour}:${part.minute}`
  }
  const walk = (one: unknown, allDay = false): unknown => {
    if (typeof one === "string") return UTC_TIME.test(one) ? local(one, allDay) : one
    if (Array.isArray(one)) return one.map((item) => walk(item))
    if (!isRecord(one)) return one
    const dates = one.all_day === true || one.allDay === true
    return Object.fromEntries(
      Object.entries(one).map(([key, item]) => [key, walk(item, dates && /^(starts|ends)_?at$/iu.test(key))]),
    )
  }
  const { meta: _meta, ...rest } = isRecord(value) ? value : { value }
  const body = isRecord(value) ? (Array.isArray(rest.items) ? rest.items : "item" in rest ? rest.item : rest) : value
  const text = renderPretty(walk(body), { color })
  return shown ? `${text}\n\ntimes in ${zone}` : text
}
