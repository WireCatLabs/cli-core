import { CliError } from "@wirecat/cli-base"
import type { Message, Reactions } from "./models.js"

export const COUNTER_FIELDS = ["views", "reactions", "comments"] as const
export type CounterField = (typeof COUNTER_FIELDS)[number]
export interface CounterObservation {
  value: number
  observedAt: string
  source: "remote_fetch" | "remote_update"
  reactions?: Reactions
}
export type CounterObservations = Partial<Record<CounterField, CounterObservation>>
export interface CounterState {
  counter: CounterField
  value: number | null
  observedAt: string | null
  source: CounterObservation["source"] | null
  ageMilliseconds: number | null
  freshness: "fresh" | "stale" | "unknown"
}
export const validCounter = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
export const counterValue = (
  message: Pick<Message, "reactions" | "providerMetadata">,
  field: CounterField,
): number | null => {
  const value = field === "reactions" ? message.reactions?.total : message.providerMetadata?.[field]
  return validCounter(value) ? value : null
}
export const counterObservationTime = (observation: CounterObservation, now: number): number => {
  const at = Date.parse(observation.observedAt)
  if (
    !validCounter(observation.value) ||
    !Number.isSafeInteger(at) ||
    at < 0 ||
    at > now ||
    !["remote_fetch", "remote_update"].includes(observation.source)
  )
    throw new CliError(
      "validation_error",
      "counter observation needs a valid value, source and nonfuture observation time",
    )
  if (
    observation.reactions &&
    (!validCounter(observation.reactions.total) || observation.reactions.total !== observation.value)
  )
    throw new CliError("validation_error", "reaction observation payload and total disagree")
  return at
}
export const observedCounters = (
  message: Message,
  observedAt: string,
  fields: readonly CounterField[],
  source: CounterObservation["source"] = "remote_fetch",
): Message => {
  const observations: CounterObservations = {}
  for (const field of fields) {
    const value = counterValue(message, field)
    if (value !== null)
      observations[field] = {
        value,
        observedAt,
        source,
        ...(field === "reactions" && message.reactions ? { reactions: message.reactions } : {}),
      }
  }
  return { ...message, counterObservations: observations }
}

export const counterFreshness = (states: readonly CounterState[]): "fresh" | "stale" | "partial" | "unknown" => {
  if (!states.length || states.every((one) => one.freshness === "unknown")) return "unknown"
  if (states.some((one) => one.freshness === "unknown")) return "partial"
  return states.some((one) => one.freshness === "stale") ? "stale" : "fresh"
}
