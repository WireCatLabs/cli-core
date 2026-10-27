/** Why a budgeted run stopped asking: its request count is spent, its deadline is close, or it was cancelled. */
export type BudgetStop = "requests" | "deadline" | "cancelled"

/** The command's hard limit as `run()` started it: when it ends, and how long it was. */
export interface Deadline {
  endsAt: number
  ms: number
}

/**
 * A sync asks it before each request to the source, so the run stops on its own, saves where it is, and says
 * "run again to continue" instead of being cut by its deadline.
 */
export interface RunBudget {
  /** One more request: `null` when it may go, otherwise why not. Once it says no it keeps saying no. */
  take(): BudgetStop | null
  readonly used: number
  /** `null`: no request limit, only the deadline. */
  readonly limit: number | null
  readonly stopped: BudgetStop | null
}

export const DEADLINE_MARGIN_MS = 5_000
export const DEADLINE_MARGIN_SHARE = 0.15
/** With no `--max-pages`, one request for every 2 s of the deadline: 15 in the default 30 s. */
export const MS_PER_REQUEST = 2_000

export const defaultRequests = (deadline: Deadline | undefined): number | null =>
  deadline === undefined ? null : Math.max(1, Math.floor(deadline.ms / MS_PER_REQUEST))

export const runBudget = ({
  requests,
  deadline,
  signal,
  now = Date.now,
}: {
  requests?: number
  deadline?: Deadline
  signal?: AbortSignal
  now?: () => number
} = {}): RunBudget => {
  const limit = requests ?? defaultRequests(deadline)
  const margin = deadline ? Math.max(DEADLINE_MARGIN_MS, deadline.ms * DEADLINE_MARGIN_SHARE) : 0
  let used = 0
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
    get used() {
      return used
    },
    limit,
    get stopped() {
      return stopped
    },
  }
}
