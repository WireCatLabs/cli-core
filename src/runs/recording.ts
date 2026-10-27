import { processStreams, type RenderFormat, type Streams } from "@wirecat/cli-base"
import { isCliFailure } from "../errors/failures.js"
import type { AppIdentity } from "../ports/app.js"
import { endpointTemplate, errorDetailOf, framesOf } from "./error-detail.js"
import { type DiagnosticEvent, type EventSink, providerErrorKey, type RequestEvent, renderEvent } from "./events.js"
import { DIAGNOSTIC_LOG_EVENTS } from "./log-events.js"
import { logAttributes } from "./log-keys.js"
import { newRunId, type Run, type RunContext, runsDirFor, startRun } from "./run.js"
import { enclosingTraceId, inRun, type RunScope, traceOf, useAsProcessRun } from "./scope.js"

export interface RecordingOptions {
  app: AppIdentity
  /** As typed, without the arguments: `chats list`. It names the run directory. */
  command: string
  /** Unset when nothing named one: a run is never put down to a profile the owner did not choose. */
  profile?: string
  record: boolean
  /** Keep the run if it fails, even though `record` is off. */
  keepFailed: boolean
  trace: boolean
  /** Diagnostics follow the data stream: text for a person, one JSON object per line otherwise. */
  format: RenderFormat
  streams?: Streams
  env?: NodeJS.ProcessEnv
  runsDir?: string
  keepDays?: number
  now?: () => Date
  /** The caller's trace; otherwise the enclosing run's, otherwise `TRACEPARENT` from `env`. */
  traceId?: string
  /**
   * A one-shot command prints its answer after the run ends, outside `inRun`: naming the run as the process's lets
   * that answer's `meta.run_id` name the run `runs show` finds. Never in a server, where runs overlap.
   */
  processRun?: boolean
  /** The whole command, its masked arguments and the agent that started it. */
  context?: RunContext
}

/**
 * Runs one command with the diagnostics turned on, and **finalizes on every path**.
 *
 * `--trace` shows each event as it happens and keeps nothing, `--record` keeps it and shows
 * nothing. It is a wrapper rather than three lines in each command because the failure it prevents
 * is the quiet one: a run directory left saying `running` because the command threw on the way out.
 */
export const recorded = async <T>(options: RecordingOptions, body: (events: EventSink) => Promise<T>): Promise<T> => {
  const recording = startRecording(options)
  try {
    const scope: RunScope = {
      runId: recording.runId,
      command: options.command,
      startedAt: Date.now(),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(recording.traceId ? { traceId: recording.traceId } : {}),
      events: recording.events,
    }
    if (options.processRun) useAsProcessRun(scope)
    const answer = await inRun(scope, () => body(recording.events))
    await recording.succeed(answer)
    return answer
  } catch (error) {
    await recording.fail(error)
    throw error
  }
}

export interface Recording {
  /** Given now, before the run is kept or not, so whatever the command writes can name it. */
  runId: string
  traceId?: string
  events: EventSink
  succeed: (answer?: unknown) => Promise<void>
  /** Marks the error as dealt with, so the program's last catch does not keep it a second time. */
  fail: (error: unknown) => Promise<void>
}

/** `recorded` in two halves, for a caller that starts a run before its command and ends it after (max-cli's `max bot`). */
export const startRecording = (options: RecordingOptions): Recording => {
  const streams = options.streams ?? processStreams
  const now = options.now ?? (() => new Date())
  const startedAt = now()
  const runId = newRunId(startedAt, options.command)
  const traceId = options.traceId ?? enclosingTraceId() ?? traceOf(options.env ?? process.env).traceId

  const open = (extra: { startedAt?: Date } = {}): Run =>
    startRun({
      runsDir: options.runsDir ?? runsDirFor(options.app, options.env),
      runId,
      command: options.command,
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      service: options.app.command,
      cliVersion: options.app.version,
      ...(traceId === undefined ? {} : { traceId }),
      ...(options.context ? { context: options.context } : {}),
      // The operation has happened or is under way, and failing the command now invites a retry
      // that sends twice.
      onError: (error) => {
        const warning = `this run is not recorded past this point: ${error.message}`
        streams.diagnostic(options.format === "pretty" ? warning : JSON.stringify({ warning }))
      },
      ...(options.keepDays === undefined ? {} : { keepDays: options.keepDays }),
      now,
      ...extra,
    })

  const run = options.record ? open({ startedAt }) : undefined
  // Unrecorded, the newest events are held until the outcome is known, so a failure can still be kept.
  const held: DiagnosticEvent[] | undefined = !run && options.keepFailed ? [] : undefined
  const counted = { wire: 0, operation: 0 }
  let refused: RequestEvent | undefined
  const cap = capped()
  const requests = () => (counted.wire > 0 ? counted.wire : counted.operation)

  const events: EventSink = (event) => {
    if (event.event === "request") counted[event.level === "wire" ? "wire" : "operation"] += 1
    if (event.event === "response" && event.outcome === "error") refused = event
    if (options.trace)
      streams.diagnostic(options.format === "pretty" ? renderEvent(event) : JSON.stringify(logAttributes(event)))
    if (run) cap.log(run, event)
    if (held) {
      held.push(event)
      if (held.length > HELD_AT_MOST) held.shift()
    }
  }
  const keep = (kept: Run): Run => {
    for (const event of held ?? []) cap.log(kept, event)
    return kept
  }

  return {
    runId,
    ...(traceId === undefined ? {} : { traceId }),
    events,
    succeed: async (answer) => {
      const partial = partialOutcome(answer)
      const kept = run ?? (partial && held ? keep(open({ startedAt })) : undefined)
      if (kept) cap.close(kept)
      await kept?.finish(partial ? "partial" : "success", {
        requests: requests(),
        ...cap.dropped(),
        ...(partial ? { partial } : {}),
      })
    },
    fail: async (error) => {
      const failed = run ?? (held ? keep(open({ startedAt })) : undefined)
      if (failed) {
        if (!isCliFailure(error)) failed.logger.error(crashOf(error))
        cap.close(failed)
        await failed.finish("failed", {
          requests: requests(),
          ...cap.dropped(),
          ...outcomeOf(error),
          error: errorDetailOf(error, refused),
          ...(run ? {} : { keptBecauseFailed: true }),
        })
      }
      if (typeof error === "object" && error !== null) settled.add(error)
    },
  }
}

/** Failures a run already dealt with — kept, or not kept by the owner's choice. `run()`'s last catch skips them. */
const settled = new WeakSet<object>()

export const wasSettled = (error: unknown): boolean => typeof error === "object" && error !== null && settled.has(error)

const HELD_AT_MOST = 500

/** A run of a loop that never ends must not fill the disk: past these, events are counted by operation instead. */
export const EVENTS_AT_MOST = 2000
export const EVENT_BYTES_AT_MOST = 1024 * 1024

const capped = () => {
  let lines = 0
  let bytes = 0
  let dropped = 0
  const byOperation: Record<string, number> = {}
  return {
    log: (run: Run, event: DiagnosticEvent): void => {
      // The record's own envelope (time, ids of the run, resource) is about 200 bytes on top of its attributes.
      const size = JSON.stringify(logAttributes(event)).length + 200
      if (lines >= EVENTS_AT_MOST || bytes + size > EVENT_BYTES_AT_MOST) {
        dropped += 1
        const operation = "operation" in event && event.operation ? event.operation : event.event
        byOperation[operation] = (byOperation[operation] ?? 0) + 1
        return
      }
      lines += 1
      bytes += size
      logEvent(run, event)
    },
    close: (run: Run): void => {
      if (dropped > 0) run.logger.warn({ event: "events.dropped", dropped, counts: byOperation })
    },
    dropped: (): { eventsDropped?: number } => (dropped > 0 ? { eventsDropped: dropped } : {}),
  }
}

const logEvent = (run: Run, event: DiagnosticEvent): void => {
  const record = {
    ...event,
    event: DIAGNOSTIC_LOG_EVENTS[event.event],
    ...("endpointTemplate" in event && event.endpointTemplate !== undefined
      ? { endpointTemplate: endpointTemplate(event.endpointTemplate) }
      : {}),
  }
  if (event.event === "warning") run.logger.warn(record)
  else if (event.event !== "cache" && event.outcome === "error") run.logger.error(record)
  else run.logger.info(record)
}

const outcomeOf = (error: unknown): { errorCode: string; providerError?: string } => {
  if (!isCliFailure(error)) return { errorCode: "generic_failure" }
  const providerError = providerErrorKey(error.details?.provider_error)
  return { errorCode: error.code, ...(providerError ? { providerError } : {}) }
}

/**
 * Where a crash happened, not what it said: the class and up to ten frames as `function file:line`,
 * paths cut to the package's own (`framesOf`). **Never `message`** in an event — it can hold whatever the
 * failing line was handling; run.json's `error` keeps it, masked.
 */
export const crashOf = (error: unknown): { event: "command.crashed"; errorClass: string; frames: string[] } => ({
  event: "command.crashed",
  errorClass: error instanceof Error ? error.name : typeof error,
  frames: framesOf(error, 10),
})

export const partialOutcome = (answer: unknown): import("./run.js").RunMetadata["partial"] => {
  if (!answer || typeof answer !== "object") return undefined
  const body = ("item" in answer ? answer.item : answer) as {
    batch?: {
      failed?: number
      stopReason?: string
      failures?: { id: string; stage: string; attachment?: number; error: { code: string } }[]
    }
    issue?: { code: string }
    chat?: string
  }
  if (body.batch?.failed)
    return {
      failed: body.batch.failed,
      ...(body.batch.stopReason ? { stopReason: body.batch.stopReason } : {}),
      failures: (body.batch.failures ?? []).map((failure) => ({
        id: failure.id,
        stage: failure.stage,
        errorCode: failure.error.code,
        ...(failure.attachment === undefined ? {} : { attachment: failure.attachment }),
      })),
    }
  if (body.issue)
    return { failed: 1, failures: [{ id: body.chat ?? "history", stage: "history", errorCode: body.issue.code }] }
  return undefined
}
