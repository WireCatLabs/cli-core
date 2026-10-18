import { CliError } from "@wirecat/cli-base"
import { parseDuration } from "./duration.js"

/** `86400` as `24h` and `604800` as `7d`: a day reads in hours, as the messenger apps offer it. */
export const spokenSeconds = (seconds: number): string => {
  if (seconds % 86_400 === 0 && seconds > 86_400) return `${seconds / 86_400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

export const pinDurationsText = (allowed: readonly number[]): string => {
  const words = allowed.map(spokenSeconds)
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words.at(-1)}` : (words[0] ?? "")
}

/** `--expire-time 7d` as seconds, one of the lengths the messenger offers; `undefined` leaves its default. */
export const pinDurationOf = (
  value: string | undefined,
  allowed: readonly number[] | undefined,
  flag = "--expire-time",
): number | undefined => {
  if (value === undefined) return undefined
  if (!allowed?.length) throw new CliError("validation_error", "pins here never expire")
  const refused = () =>
    new CliError("validation_error", `${flag} takes ${pinDurationsText(allowed)} from now — not "${value}"`)
  let seconds: number
  try {
    seconds = parseDuration(value, flag) / 1000
  } catch {
    throw refused()
  }
  if (!allowed.includes(seconds)) throw refused()
  return seconds
}
