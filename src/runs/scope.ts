import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"
import { traceIdOf } from "@wirecat/cli-base/standards"
import type { EventSink } from "./events.js"
import { newRunId } from "./run.js"

export interface RunScope {
  runId: string
  command: string
  /** Epoch ms; an answer's `meta.duration_ms` counts from here. */
  startedAt?: number
  /** The caller's trace — an MCP client's `_meta.traceparent`, or `TRACEPARENT` from whatever started this process. */
  traceId?: string
  /** The profile the run is for, so a hint deep in a service can name the command with it. */
  profile?: string
  /** The run's event sink, for a transport far below the command (a wire middleware) that is not handed one. */
  events?: EventSink
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

/** One event into the run under way, or nowhere: outside a run, or in a run that keeps nothing. */
export const runEvent: EventSink = (event) => scopes.getStore()?.events?.(event)

/**
 * A command as a person types it: `max personal store migrate`. A hint without the profile fails when copied,
 * since no profile is assumed; outside a run with a profile it stays `max store migrate`.
 */
export const typedCommand = (tool: string, words: string, profile = currentRun().profile): string =>
  [tool, profile, words].filter((part) => part !== undefined && part !== "").join(" ")

/**
 * For a one-shot command whose action runs outside `inRun` — max's `max bot`, recorded from commander's hooks, which
 * cannot wrap the action — so its answers' `meta.run_id` names the run `runs show` finds. Never in a server.
 */
export const useAsProcessRun = (scope: RunScope | undefined): void => {
  processScope = scope
}

/** The run `useAsProcessRun` named, if any: a command run in-process puts it back when it ends. */
export const processRun = (): RunScope | undefined => processScope

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

export interface Attempt {
  attempt: number
  waitMs?: number
}

const attempts = new AsyncLocalStorage<Attempt>()

/** Marks the calls made under it as one try of a retried call: a wire event without its own attempt takes this one. */
export const withAttempt = <T>(attempt: Attempt, work: () => T): T => attempts.run(attempt, work)

export const currentAttempt = (): Attempt | undefined => attempts.getStore()
