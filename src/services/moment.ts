import { CliError } from "@wirecat/cli-base"
import { timezoneOf } from "@wirecat/cli-base/query"
import { aheadOf, type MomentZone, type Reading, readMoment } from "../domain/moment.js"

export type { MomentZone }
export { aheadOf }

const read = (reference: string, flag: string, now: number, at: MomentZone): Reading => {
  const found = readMoment(reference, flag, { ...at, now })
  if (found === undefined)
    throw new CliError(
      "validation_error",
      `${flag} takes an ISO 8601 time, today, yesterday, or 30m, 2h, 1d ago — not "${reference.trim()}"`,
    )
  return found
}

/**
 * `--since` as a moment, in the shared time grammar (`readMoment`). Unlike max-cli, never a message id — a MAX id
 * carries its time, and a Telegram id is only a counter within one chat.
 */
export const momentOf = (reference: string, flag = "--since", now = Date.now(), at: MomentZone = {}): number =>
  read(reference, flag, now, at).time

export interface DateWindow {
  since?: number
  until?: number
  /** What the answer says about it: the zone a value without one was read in, and the bounds in UTC. */
  meta: { timezone?: string; window?: { since?: string; until?: string } }
}

/** `--since-time` and `--until-time` together, as the filter and the `meta` an answer reports it by. */
export const dateWindow = ({
  sinceTime,
  untilTime,
  zone,
  now = Date.now(),
  names = ["--since-time", "--until-time"],
}: {
  sinceTime?: string
  untilTime?: string
  zone?: string
  now?: number
  /** How the caller spells the two, for the error: `since_time` over MCP. */
  names?: [string, string]
}): DateWindow => {
  const at = zone === undefined ? {} : { zone }
  const lower = sinceTime === undefined ? undefined : read(sinceTime, names[0], now, at)
  const upper = untilTime === undefined ? undefined : read(untilTime, names[1], now, { ...at, end: true })
  const since = lower?.time
  const until = upper?.time
  const readInZone = lower?.local === true || upper?.local === true
  const window = {
    ...(since === undefined ? {} : { since: new Date(since).toISOString() }),
    ...(until === undefined ? {} : { until: new Date(until).toISOString() }),
  }
  return {
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    meta: {
      ...(readInZone ? { timezone: timezoneOf(zone) } : {}),
      ...(since === undefined && until === undefined ? {} : { window }),
    },
  }
}
