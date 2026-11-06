import { renderPretty } from "@wirecat/cli-base"
import { UTC_TIME, wallClock } from "../../cli/local-times.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A calendar answer as a person reads it at a terminal (WC-TIME-4): each UTC time on the wall clock of `zone`, an
 * all-day event's times as its local dates, and a last line naming the zone. JSON keeps the UTC times.
 */
export const localTimesView = (value: unknown, zone: string, color: boolean): string => {
  const clock = wallClock(zone)
  let shown = false
  const local = (text: string, dateOnly: boolean) => {
    shown = true
    return dateOnly ? clock.date(text) : clock.time(text)
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
