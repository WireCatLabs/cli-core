import { CliError } from "@wirecat/cli-base"
import { timezoneOf, zonedMoment } from "@wirecat/cli-base/query"

export interface MomentZone {
  /** The IANA zone a date or a time without a zone is read in; the computer's zone when left out. */
  zone?: string
  /** A date alone means the last millisecond of that local day, not its first: the end of a range. */
  end?: boolean
}

/** A typed date or time as epoch ms, with the flag named when it is not one. */
export const calendarMoment = (wanted: string, flag: string, { zone, end = false }: MomentZone = {}): number => {
  try {
    return zonedMoment(wanted, timezoneOf(zone), { start: 0, end: wanted.length }, { end })
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    const alternative = (error.details as { alternative?: string } | undefined)?.alternative
    throw new CliError(
      "validation_error",
      `${flag}: "${wanted}" is not a time${alternative ? ` — ${alternative}` : ""}`,
    )
  }
}
