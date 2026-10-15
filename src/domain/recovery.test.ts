import { expect, it } from "vitest"
import { withRecovery } from "./recovery.js"

it("calls a provider's wait retryable and an uncertain write not, and names no prose actions", () => {
  const waited = withRecovery({ code: "rate_limited", message: "wait", retry_after_ms: 30000 })
  expect(waited).toMatchObject({ retryable: true, retry_after_ms: 30000 })
  expect(waited).not.toHaveProperty("actions")
  expect(withRecovery({ code: "outcome_unknown", message: "write outcome unknown" }).retryable).toBe(false)
  expect(withRecovery({ code: "provider_error", message: "busy", status: 429 }).retryable).toBe(true)
  expect(withRecovery({ code: "rate_limited", message: "no", retryable: false }).retryable).toBe(false)
})
