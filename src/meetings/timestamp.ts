import { CliError } from "@wirecat/cli-base"

export const meetingTimestamp = (value: unknown, name: string): string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new CliError("validation_error", `${name} must be an ISO timestamp with a timezone`)
  const date = value.slice(0, 10)
  const instant = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== date)
    throw new CliError("validation_error", `${name} contains an invalid calendar date`)
  return new Date(value).toISOString()
}
