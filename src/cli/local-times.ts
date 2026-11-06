import { timezoneOf } from "@wirecat/cli-base/query"
import type { Command } from "commander"
import { environmentOf } from "./context.js"
import { type AnswerOutput, type Body, renderAnswer } from "./envelope.js"

export const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u

/** `YYYY-MM-DD HH:MM` on the wall clock of `zone`, with no offset: the answer names the zone once. */
export const wallClock = (zone: string) => {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  const parts = (iso: string) =>
    Object.fromEntries(format.formatToParts(Date.parse(iso)).map(({ type, value }) => [type, value]))
  const date = (iso: string) => {
    const part = parts(iso)
    return `${part.year}-${part.month}-${part.day}`
  }
  return {
    date,
    time: (iso: string) => {
      const part = parts(iso)
      return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}`
    },
  }
}

/** Turns a UTC time into the shown one; any other text comes back as it was. */
export type ShownTime = (value: string) => string

const localised = (value: unknown, shown: ShownTime): unknown => {
  if (typeof value === "string") return shown(value)
  if (Array.isArray(value)) return value.map((one) => localised(one, shown))
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, localised(one, shown)]))
  return value
}

/**
 * Answers as `renderAnswer` does, and a person reads every UTC time in the zone in use (`zone`, else the computer's),
 * with one line naming it (WC-TIME-4). A `view` builds its text with the `shown` it is given. JSON, JSONL, compact
 * rows and agents keep UTC (WC-TIME-2), and `next` is left alone: its args run.
 */
export const answerLocally = <T>(
  command: Command,
  output: AnswerOutput,
  body: Body<T>,
  view?: (shown: ShownTime) => string,
  zone?: string,
): void => {
  if (output.format !== "pretty" || output.compact || environmentOf(command).agent) {
    renderAnswer(command, output, body, view && (() => view((value) => value)))
    return
  }
  const inUse = timezoneOf(zone)
  const clock = wallClock(inUse)
  let seen = false
  const shown: ShownTime = (value) => {
    if (!UTC_TIME.test(value)) return value
    seen = true
    return clock.time(value)
  }
  if (view) renderAnswer(command, output, body, () => view(shown))
  else
    renderAnswer(
      command,
      output,
      ("items" in body
        ? { ...body, items: body.items.map((one) => localised(one, shown)) }
        : { ...body, item: localised(body.item, shown) }) as Body<T>,
    )
  if (seen) output.renderer.note(`times in ${inUse}`)
}
