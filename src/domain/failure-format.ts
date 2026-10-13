import { errorObjectOf, type FailureContext } from "@wirecat/cli-base"
import { isCliFailure } from "./errors.js"

export type ErrorContract = "standard" | "legacy"

/** Existing consumers opt in while migrating their released machine error contract. */
export const failureObjectOf = (
  failure: unknown,
  context: FailureContext = {},
  contract: ErrorContract = "standard",
) => {
  const object = errorObjectOf(failure, context)
  if (contract !== "legacy" || !isCliFailure(failure)) return object
  const { cause: _cause, reason, ...details } = failure.details
  const aliases: Record<string, string> = { "input.too-large": "input_limit", "output.too-large": "output_limit" }
  const named = typeof reason === "string" ? reason : object.error.reason
  return {
    error: {
      ...object.error,
      ...details,
      code: object.error.code,
      message: object.error.message,
      reason: aliases[named] ?? named,
    },
  }
}
