import { CliError } from "@wirecat/cli-base"
import { calendarMoment } from "./moment.js"

const MINUTE = 60_000
const YEAR = 365 * 24 * 60 * MINUTE
const DELAY = /^(\d+)(m|h|d)$/
const UNIT_MS: Record<string, number> = { m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE }

/**
 * `--at-time`: a time like `2026-09-25T09:00`, or a delay like `30m`, `2h`, `1d`, as an ISO time — the
 * same words max-cli takes. Rounded down to the minute, because messengers send at the start of it
 * (MAX measured, max-cli `FIND-141`), so the time printed is the time it goes. A time without an
 * offset is read in `zone`, the computer's zone when none is given.
 */
export const sendTime = (value: string, now = Date.now(), flag = "--at-time", zone?: string): string => {
  const trimmed = value.trim()
  const [, amount, unit] = DELAY.exec(trimmed) ?? []
  const at = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)
    ? calendarMoment(trimmed.replace(" ", "T"), flag, zone === undefined ? {} : { zone })
    : amount && unit
      ? now + Number(amount) * (UNIT_MS[unit] ?? 0)
      : Number.NaN
  if (Number.isNaN(at)) {
    throw new CliError(
      "validation_error",
      `${flag} takes a time like 2026-09-25T09:00 or a delay like 30m, 2h, 1d — not "${value}"`,
    )
  }
  if (at < now + MINUTE) throw new CliError("validation_error", `${flag} has to be at least a minute from now`)
  if (at > now + YEAR) throw new CliError("validation_error", `${flag} can be at most a year from now`)
  return new Date(at - (at % MINUTE)).toISOString()
}
