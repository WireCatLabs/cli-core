import * as v from "valibot"
import { count, id, text } from "./fields.js"

/** Per-item recovery retains the diagnostic fields the provider supplied. */
export const actionableError = v.objectWithRest(
  {
    code: text,
    message: text,
    retryable: v.boolean(),
    retry_after_ms: v.optional(v.number()),
  },
  v.unknown(),
)

export const batchResult = v.strictObject({
  attempted: count,
  succeeded: count,
  failed: count,
  error_rate: v.number(),
  failures: v.array(v.strictObject({ id, stage: text, error: actionableError, attachment: v.optional(count) })),
  stop_reason: v.optional(v.picklist(["rate_limited", "authentication", "error_rate", "cancelled"])),
  max_error_percent: count,
})
