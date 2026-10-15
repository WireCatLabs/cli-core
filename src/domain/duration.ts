import { CliError } from "@wirecat/cli-base"

const DURATION = /^(\d+)(ms|s|m|h|d)$/
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Named by where it came from, so somebody who set the variable weeks ago is told which thing is wrong. */
export const parseDuration = (value: string, source: string): number => {
  const match = DURATION.exec(value.trim())
  if (!match?.[1] || !match[2]) {
    throw new CliError(
      "validation_error",
      `${source} takes a duration with a unit — 500ms, 30s, 2m, 4h or 1d — not "${value}"`,
    )
  }
  const ms = Number(match[1]) * (UNIT_MS[match[2]] ?? 0)
  if (ms <= 0) throw new CliError("validation_error", `${source} has to be more than zero, and "${value}" is not`)
  return ms
}
