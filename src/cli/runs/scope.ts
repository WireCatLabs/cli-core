import { AsyncLocalStorage } from "node:async_hooks"
import { newRunId } from "./run.js"

export interface RunScope {
  runId: string
  command: string
  /** Epoch ms; an answer's `meta.duration_ms` counts from here. */
  startedAt?: number
}

const scopes = new AsyncLocalStorage<RunScope>()

let processScope: RunScope | undefined

/**
 * The run a log line written now belongs to, for a writer that is not handed one — the send journal,
 * the serve log. Outside any run, one id for the whole process, so its lines still group together.
 */
export const currentRun = (): RunScope => {
  const scope = scopes.getStore()
  if (scope) return scope
  processScope ??= { runId: newRunId(new Date(), "process"), command: "", startedAt: Date.now() }
  return processScope
}

export const inRun = <T>(scope: RunScope, body: () => T): T => scopes.run(scope, body)
