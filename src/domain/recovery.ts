export interface ActionableError {
  code: string
  message: string
  retryable: boolean
  retry_after_ms?: number
  [key: string]: unknown
}

/** A per-item failure as a batch reports it: retryable when the provider asked to wait, unless it said otherwise. */
export const withRecovery = (error: { code: string; message: string; [key: string]: unknown }): ActionableError => ({
  ...error,
  retryable:
    typeof error.retryable === "boolean" ? error.retryable : error.code === "rate_limited" || error.status === 429,
})
