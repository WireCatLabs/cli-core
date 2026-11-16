/** Why a budgeted run stopped asking: its request count is spent, its deadline is close, or it was cancelled. */
export type BudgetStop = "requests" | "deadline" | "cancelled"

/** The command's hard limit as `run()` started it: when it ends, and how long it was. */
export interface Deadline {
  endsAt: number
  ms: number
  /** A person or a script set it (`--timeout`, `<PREFIX>_TIMEOUT`), not the command's default. */
  explicit?: true
}

/**
 * A sync asks it before each request to the source, so the run stops on its own, saves where it is, and says
 * "run again to continue" instead of being cut by its deadline.
 */
export interface RunBudget {
  /** One more request: `null` when it may go, otherwise why not. Once it says no it keeps saying no. */
  take(): BudgetStop | null
  /**
   * After `take()` said "deadline": whether the call's first request goes anyway. Only while nothing has gone yet,
   * once, and when one request still ends before the deadline itself with time left to answer.
   */
  first?(): boolean
  readonly used: number
  /** `null`: no request limit, only the deadline. */
  readonly limit: number | null
  readonly stopped: BudgetStop | null
}

export const DEADLINE_MARGIN_MS = 5_000
export const DEADLINE_MARGIN_SHARE = 0.15
/** How long one request to a provider is expected to take when the CLI does not say (`AppIdentity.requestMs`). */
export const DEFAULT_REQUEST_MS = 2_000

/** Kept after a request for the answer, the catalog import and the state save. */
export const ANSWER_RESERVE_MS = 500

/** Whether one more request still ends before the deadline itself, with time left to answer. */
export const oneMoreFits = (deadline: Deadline | undefined, at: number, requestMs = DEFAULT_REQUEST_MS): boolean =>
  deadline !== undefined && at + requestMs + ANSWER_RESERVE_MS < deadline.endsAt

export const deadlineMargin = (deadline: Deadline): number =>
  Math.max(DEADLINE_MARGIN_MS, deadline.ms * DEADLINE_MARGIN_SHARE)

/** The requests that fit before the margin: `(deadline − margin) / requestMs`, at least one; none without a deadline. */
export const requestsFor = (deadline: Deadline | undefined, requestMs = DEFAULT_REQUEST_MS): number | null =>
  deadline === undefined ? null : Math.max(1, Math.floor((deadline.ms - deadlineMargin(deadline)) / requestMs))

/**
 * Stops at whichever comes first: the requests that fit the deadline (`requestsFor`), an explicit `requests` lower
 * than that, the deadline's margin plus the slowest request so far, or the signal.
 */
export const runBudget = ({
  requests,
  deadline,
  requestMs,
  signal,
  now = Date.now,
}: {
  requests?: number
  deadline?: Deadline
  requestMs?: number
  signal?: AbortSignal
  now?: () => number
} = {}): RunBudget => {
  const fits = requestsFor(deadline, requestMs)
  const limit = fits === null ? (requests ?? null) : Math.min(fits, requests ?? fits)
  const margin = deadline ? deadlineMargin(deadline) : 0
  let used = 0
  let granted = false
  let stopped: BudgetStop | null = null
  let last: number | undefined
  // A request may page inside the source, so the gap between two asks is the honest measure of one.
  let slowest = 0
  return {
    take() {
      if (stopped) return stopped
      const at = now()
      if (last !== undefined) slowest = Math.max(slowest, at - last)
      if (signal?.aborted) stopped = "cancelled"
      else if (limit !== null && used >= limit) stopped = "requests"
      else if (deadline && at + margin + slowest >= deadline.endsAt) stopped = "deadline"
      if (stopped) return stopped
      used += 1
      last = at
      return null
    },
    first() {
      if (granted || used > 0 || stopped !== "deadline") return false
      const at = now()
      if (!oneMoreFits(deadline, at, Math.max(requestMs ?? DEFAULT_REQUEST_MS, slowest))) return false
      granted = true
      used += 1
      last = at
      return true
    },
    get used() {
      return used
    },
    limit,
    get stopped() {
      return stopped
    },
  }
}
