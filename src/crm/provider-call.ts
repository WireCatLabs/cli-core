import { backoffMs, CliError, isCliError, type RetryConfig, realSleep } from "@wirecat/cli-base"
import { type Pacer, type TurnOptions, waitForTurn } from "../sends/pace.js"

const RETRY: RetryConfig = { retries: 3, baseDelayMs: 1_000, maxDelayMs: 10_000, maxRetryAfterMs: 30_000 }
/** A write cut off by these may have reached the CRM: only a refusal says it did not. */
const UNANSWERED = new Set(["timeout", "network_error", "provider_unavailable"])

export interface ProviderCallOptions<T> {
  /** A write is tried again only on `rate_limited`, which a CRM answers before doing anything. */
  write: boolean
  /** One HTTP exchange; it throws a cli-base `CliError` with a reason. */
  send: () => Promise<T>
  /** The profile's shared pace (`@wirecat/cli-core/sends`): each attempt waits its turn, and a refused rate holds it. */
  pace?: { pacer: Pacer } & TurnOptions
  /** One token refresh on `oauth.expired`; false gives up. A refused token did nothing, so a write goes again too. */
  refresh?: () => Promise<boolean>
  /** Attempts after the first; 3 when absent. */
  retries?: number
  /** Waits between attempts; a test or a cancellable run passes its own. */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

const unanswered = (error: unknown): boolean =>
  !isCliError(error) || (UNANSWERED.has(error.code) && error.details.sent !== false)

/**
 * One call to a CRM: paced, reads tried again on a retryable failure or a refused rate, a write only on a refused
 * rate. A write that got no answer is `outcome_unknown` and is never sent again: a CRM may have carried it out.
 */
export const providerCall = async <T>(options: ProviderCallOptions<T>): Promise<T> => {
  const retries = options.retries ?? RETRY.retries
  const sleep = options.sleep ?? ((ms: number) => realSleep(ms))
  let refreshed = false
  for (let attempt = 1; ; attempt++) {
    if (options.pace) await waitForTurn(options.pace.pacer, options.pace)
    try {
      return await options.send()
    } catch (error) {
      if (
        !refreshed &&
        options.refresh &&
        isCliError(error) &&
        error.code === "authentication_error" &&
        error.details.reason === "oauth.expired"
      ) {
        refreshed = true
        if (await options.refresh()) continue
        throw error
      }
      if (options.write && unanswered(error))
        throw new CliError(
          "outcome_unknown",
          `${error instanceof Error ? error.message : String(error)}; the CRM may or may not have carried it out`,
          { ...(isCliError(error) ? error.details : {}), retryable: false },
        )
      if (!isCliError(error)) throw error
      const asked = error.details.retry_after_ms
      const wait = typeof asked === "number" ? asked : backoffMs(attempt, RETRY, options.random ?? Math.random)
      const again = error.code === "rate_limited" || (!options.write && error.details.retryable === true)
      if (!again || wait > RETRY.maxRetryAfterMs || attempt > retries) throw error
      if (error.code === "rate_limited") await options.pace?.pacer.holdFor(wait)
      await sleep(wait)
    }
  }
}
