import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"
import { traceIdOf } from "@wirecat/cli-base/standards"
import { newRunId } from "./run.js"

export interface RunScope {
  runId: string
  command: string
  /** Epoch ms; an answer's `meta.duration_ms` counts from here. */
  startedAt?: number
  /** The caller's trace — an MCP client's `_meta.traceparent`, or `TRACEPARENT` from whatever started this process. */
  traceId?: string
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
  processScope ??= {
    runId: newRunId(new Date(), "process"),
    command: "",
    startedAt: Date.now(),
    ...traceOf(process.env),
  }
  return processScope
}

export const inRun = <T>(scope: RunScope, body: () => T): T => scopes.run(scope, body)

/** The trace of the run this one is opened inside — an MCP call's command keeps its caller's trace. */
export const enclosingTraceId = (): string | undefined => scopes.getStore()?.traceId

/**
 * `TRACEPARENT` is the W3C propagator's key as OpenTelemetry's environment carrier spells it
 * (https://opentelemetry.io/docs/specs/otel/context/env-carriers/): a schedule or a job sets it, so the
 * commands it starts share its trace id.
 */
export const traceOf = (env: NodeJS.ProcessEnv): { traceId?: string } => {
  const traceId = traceIdOf(env.TRACEPARENT)
  return traceId === undefined ? {} : { traceId }
}

/** A fresh `traceparent` for a child process, and the trace id its lines and ours share. */
export const childTrace = (): { traceId: string; traceparent: string } => {
  const hex = (bytes: number) => randomBytes(bytes).toString("hex")
  const traceId = hex(16)
  return { traceId, traceparent: `00-${traceId}-${hex(8)}-01` }
}
