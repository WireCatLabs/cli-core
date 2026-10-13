import { AsyncLocalStorage } from "node:async_hooks"
import { CliError } from "@wirecat/cli-base"
import type { Id } from "../domain/models.js"
import type { SendGuard } from "./guard.js"
import type { SendEntry } from "./journal.js"
import type { PermissionKey } from "./permissions.js"

/** `personIds` reach the guard's recipient check and never the journal. */
type Attempt = Omit<SendEntry, "at" | "profile" | "outcome"> & {
  operationId: string
  key?: PermissionKey
  personIds?: Id[]
}

/** A write's answer, with the id its journal lines and run events carry. */
export type Operated<T> = T & { operationId: string }

const current = new AsyncLocalStorage<string>()

/** A write that has gone and not been answered: `cut` records it as an unknown outcome, once. */
export interface WriteInFlight {
  operationId: string
  preparing?: boolean
  cut: () => void
}

/**
 * The writes in flight inside one command's deadline (`withDeadline`). A deadline that ends the
 * command while one is out cannot say "timeout" — the messenger may have carried it out — so it
 * cuts each into an unknown outcome. Per deadline, not per process: an MCP server runs many.
 */
export const writesInFlight = new AsyncLocalStorage<Set<WriteInFlight>>()
const parents = new WeakMap<Set<WriteInFlight>, Set<WriteInFlight>>()
const stopped = new WeakMap<Set<WriteInFlight>, unknown>()
const scopesFor = (scope = writesInFlight.getStore()): Set<WriteInFlight>[] => {
  const result: Set<WriteInFlight>[] = []
  for (let at = scope; at; at = parents.get(at)) result.push(at)
  return result
}
export const withWriteScope = <T>(scope: Set<WriteInFlight>, body: () => T): T => {
  const parent = writesInFlight.getStore()
  if (parent && parent !== scope) parents.set(scope, parent)
  return writesInFlight.run(scope, body)
}
export const stopWrites = (scope: Set<WriteInFlight>, reason: unknown): void => {
  stopped.set(scope, reason)
  for (const write of scope) write.cut()
}
const refuseStopped = (scopes: readonly Set<WriteInFlight>[]) => {
  for (const scope of scopes) if (stopped.has(scope)) throw stopped.get(scope)
}

/** The write in progress, so the run events of the calls it makes name it without the port passing it along. */
export const currentOperation = (): string | undefined => current.getStore()

/**
 * **Checked before it goes, recorded after, on every outcome** — the shape of every write. The chat
 * must already be resolved and the adapter's method found: a throw between `check` and `record`
 * would leave a reservation counted against the hourly limit.
 */
export const guardedWrite = async <T>(
  guard: SendGuard,
  attempt: Attempt,
  act: () => Promise<T>,
  settled: (done: T) => Partial<Attempt> = () => ({}),
  prepare?: () => Promise<void>,
): Promise<T> => {
  const scopes = scopesFor()
  refuseStopped(scopes)
  try {
    await guard.ask?.(attempt)
    refuseStopped(scopes)
    guard.check(attempt)
  } catch (error) {
    guard.record({ ...attempt, outcome: "refused", errorCode: codeOf(error) })
    throw error
  }
  let recorded = false
  const once = (entry: Parameters<SendGuard["record"]>[0]) => {
    if (recorded) return
    recorded = true
    guard.record(entry)
  }
  let cancelled = false
  const flight: WriteInFlight = {
    operationId: attempt.operationId,
    preparing: prepare !== undefined,
    cut: () => {
      cancelled = true
      once({
        ...attempt,
        outcome: flight.preparing ? "failed" : "outcome_unknown",
        errorCode: flight.preparing ? "timeout" : "outcome_unknown",
      })
    },
  }
  for (const scope of scopes) scope.add(flight)
  try {
    if (prepare !== undefined) await prepare()
    if (cancelled) throw new CliError("timeout", "the command ended before sending; nothing was sent")
    flight.preparing = false
    const done = await current.run(attempt.operationId, act)
    if (cancelled)
      throw new CliError(
        "outcome_unknown",
        "the command ended with a write in flight; check its result before continuing",
        { operation_id: attempt.operationId },
      )
    once({ ...attempt, ...settled(done), outcome: "sent" })
    return done
  } catch (error) {
    const code = codeOf(error)
    once({ ...attempt, outcome: code === "outcome_unknown" ? "outcome_unknown" : "failed", errorCode: code })
    if (code === "outcome_unknown" && error instanceof Error)
      throw new CliError("outcome_unknown", error.message, {
        ...(error as CliError).details,
        operation_id: attempt.operationId,
        retryable: false,
      })
    throw error
  } finally {
    for (const scope of scopes) scope.delete(flight)
  }
}

export const codeOf = (error: unknown): string =>
  typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "unknown"
