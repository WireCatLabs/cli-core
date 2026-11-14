import { aheadOf, MINUTE, YEAR } from "./moment.js"

/**
 * `--at-time`, a mute's `--until`, a link's `--expire-time`: `aheadOf` within the messenger's limits of a minute to a
 * year, and never a date alone. Rounded down to the minute, because messengers send at the start of it (MAX measured,
 * max-cli `FIND-141`), so the time printed is the time it goes.
 */
export const sendTime = (value: string, now = Date.now(), flag = "--at-time", zone?: string): string => {
  const at = aheadOf(value, flag, now, {
    ...(zone === undefined ? {} : { zone }),
    refuseDate: true,
    soonest: MINUTE,
    latest: YEAR,
  })
  return new Date(at - (at % MINUTE)).toISOString()
}
