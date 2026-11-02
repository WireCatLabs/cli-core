import { CliError } from "@wirecat/cli-base"
import { PAYMENT_DIRECTIONS, PAYMENT_STATES } from "../meetings/index.js"
import type { PaymentFilter } from "../store/store.js"
import { termField } from "./list-query.js"

/**
 * The terms a facts list adds for payments. `state` is the payment's, not `status`, which stays the review status
 * (proposed, accepted).
 */
export const PAYMENT_QUERY_FIELDS = [
  termField("open", "bool", "open:true"),
  termField("direction", "enum", "direction:to_us", { values: PAYMENT_DIRECTIONS }),
  termField("state", "enum", "state:paid", { values: PAYMENT_STATES }),
]

/** The store's payment filter from `queryTerms`' answer; `undefined` when no payment term was given. */
export const paymentFilterOf = (terms: Map<string, string>): PaymentFilter | undefined => {
  const open = terms.get("open")
  const direction = terms.get("direction") as PaymentFilter["direction"]
  const state = terms.get("state") as PaymentFilter["state"]
  if (open === undefined && direction === undefined && state === undefined) return undefined
  if (open !== undefined && open !== "true" && open !== "false")
    throw new CliError("validation_error", "open takes true or false")
  return {
    ...(open === undefined ? {} : { open: open === "true" }),
    ...(direction === undefined ? {} : { direction }),
    ...(state === undefined ? {} : { state }),
  }
}
