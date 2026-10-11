import { CliError } from "@wirecat/cli-base"

export const RETENTION_TOLERANCE = 86_400_000
export interface RetentionOptions {
  since: number
  until: number
  cutoff: number
  checkpoints: number[]
  within: number
  by: "day" | "week"
  timezone: string
  limit: number
}
export interface RetentionObservation {
  checkpoint: number
  targetAt: string
  state: "present" | "absent" | "unknown" | "pending"
  observedAt: string | null
  lagMilliseconds: number | null
  complete: boolean | null
}
export interface RetentionStay {
  stay: number
  person: string
  joinedAt: string
  cohort: string
  checkpoints: RetentionObservation[]
  activity: {
    state: "observed-message" | "no-observed-message" | "pending"
    firstMessageAt: string | null
    windowEnd: string
    archiveCovered: boolean
  }
  departure: {
    after: string | null
    atOrBefore: string | null
    early: "observed" | "not-observed" | "unknown" | "pending"
  }
}
export interface RetentionCohort {
  cohort: string
  stays: number
  checkpoints: {
    ageMilliseconds: number
    eligible: number
    observable: number
    present: number
    absent: number
    unknown: number
    pending: number
    rate: number | null
  }[]
  activity: { observed: number; noObserved: number; pending: number; archiveCovered: number }
  earlyDeparture: { observed: number; notObserved: number; unknown: number; pending: number }
}
export const validateRetentionOptions = (options: RetentionOptions): void => {
  const { since, until, cutoff, checkpoints, within, limit, by } = options
  if (
    ![since, until, cutoff].every((one) => Number.isSafeInteger(one) && one >= 0 && one <= 8.64e15) ||
    since > until ||
    until > cutoff ||
    !Number.isSafeInteger(within) ||
    within <= 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !["day", "week"].includes(by) ||
    !Array.isArray(checkpoints) ||
    !checkpoints.length ||
    checkpoints.length > 10 ||
    checkpoints.some(
      (one, index) => !Number.isSafeInteger(one) || one <= 0 || (index > 0 && one <= (checkpoints[index - 1] ?? 0)),
    )
  )
    throw new CliError(
      "validation_error",
      "retention requires an ordered date window, up to 10 increasing positive checkpoints and a limit of 1–100",
    )
  try {
    new Intl.DateTimeFormat("en", { timeZone: options.timezone }).format(cutoff)
  } catch {
    throw new CliError("validation_error", "invalid retention timezone")
  }
  if (
    checkpoints.some(
      (one) =>
        !Number.isSafeInteger(cutoff + one + RETENTION_TOLERANCE) || cutoff + one + RETENTION_TOLERANCE > 8.64e15,
    ) ||
    !Number.isSafeInteger(cutoff + within) ||
    cutoff + within > 8.64e15
  )
    throw new CliError("validation_error", "retention durations exceed the timestamp range")
}
export const retentionCohorts = (stays: RetentionStay[], options: RetentionOptions): RetentionCohort[] => {
  const groups = new Map<string, RetentionCohort>()
  for (const stay of stays) {
    const group = groups.get(stay.cohort) ?? {
      cohort: stay.cohort,
      stays: 0,
      checkpoints: options.checkpoints.map((ageMilliseconds) => ({
        ageMilliseconds,
        eligible: 0,
        observable: 0,
        present: 0,
        absent: 0,
        unknown: 0,
        pending: 0,
        rate: null,
      })),
      activity: { observed: 0, noObserved: 0, pending: 0, archiveCovered: 0 },
      earlyDeparture: { observed: 0, notObserved: 0, unknown: 0, pending: 0 },
    }
    group.stays++
    for (const [index, observation] of stay.checkpoints.entries()) {
      const point = group.checkpoints[index]
      if (!point) continue
      point[observation.state]++
      if (observation.state !== "pending") point.eligible++
      if (observation.state === "present" || observation.state === "absent") point.observable++
      point.rate = point.observable ? point.present / point.observable : null
    }
    group.activity[
      stay.activity.state === "observed-message"
        ? "observed"
        : stay.activity.state === "pending"
          ? "pending"
          : "noObserved"
    ]++
    if (stay.activity.archiveCovered) group.activity.archiveCovered++
    group.earlyDeparture[stay.departure.early === "not-observed" ? "notObserved" : stay.departure.early]++
    groups.set(stay.cohort, group)
  }
  return [...groups.values()].sort((a, b) => a.cohort.localeCompare(b.cohort))
}
