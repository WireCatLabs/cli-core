import { CliError, type Streams } from "@wirecat/cli-base"
import { stopWrites, type WriteInFlight, withWriteScope } from "../sends/guarded.js"
import type { Closeable } from "./deadline.js"
import { fieldsOf, projectFields } from "./result-fields.js"

export const DEFAULT_COMMAND_MS = 30_000
/** A `cooperative` command stops on its own before its deadline and keeps its work, so it may run longer. */
export const DEFAULT_COOPERATIVE_MS = 5 * 60_000
/**
 * A cooperative command that also declares `partial` is a resumable sync: it spends a request budget, answers
 * `partial` with `next`, and loses nothing when it stops, so a terminal lets it run longer than other cooperative work.
 */
export const DEFAULT_SYNC_MS = 15 * 60_000
/**
 * The same over MCP: clients cut a tool call at about 60 s (the MCP TypeScript SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC`
 * is 60000), so the command answers well before that.
 */
export const DEFAULT_AGENT_COOPERATIVE_MS = 45_000
export const DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024

export const byteCount = (value: string, option: string, zero = false): number => {
  const result = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(result) || result < (zero ? 0 : 1))
    throw new CliError("validation_error", `${option} takes a ${zero ? "non-negative" : "positive"} whole byte count`)
  return result
}

export interface Execution {
  signal: AbortSignal
  streams: Streams
  trackCloseable: (closeable: Closeable) => void
  configure: (options: { fields?: string; maxOutputBytes: number }) => void
  start: (timeoutMs?: number) => void
  race: <T>(body: () => Promise<T>) => Promise<T>
  abort: (error: unknown) => void
  failure: () => unknown
  finish: () => Promise<void>
}

export const execution = (
  streams: Streams,
  {
    timeoutMs,
    fields,
    maxOutputBytes = DEFAULT_OUTPUT_BYTES,
  }: {
    timeoutMs?: number
    fields?: string
    maxOutputBytes?: number
  },
): Execution => {
  const stop = new AbortController()
  const writes = new Set<WriteInFlight>()
  const closeables = new Set<Closeable>()
  const closing = new WeakMap<Closeable, Promise<void>>()
  const originals = new Map<Closeable, Closeable["close"]>()
  let paths = fields === undefined ? undefined : fieldsOf(fields)
  let active = true
  let bytes = 0
  let timer: NodeJS.Timeout | undefined
  let interrupted: unknown
  let reject: (error: unknown) => void = () => {}
  const interruption = new Promise<never>((_, fail) => {
    reject = fail
  })
  void interruption.catch(() => {})
  const abort = (error: unknown) => {
    if (stop.signal.aborted) return
    const pending = [...writes]
    const cut = pending.filter((write) => !write.preparing)
    interrupted = cut.length
      ? new CliError("outcome_unknown", "the command ended with a write in flight — check before repeating it", {
          operation_ids: cut.map((write) => write.operationId),
          retryable: false,
        })
      : error
    stopWrites(writes, interrupted)
    reject(interrupted)
    stop.abort(interrupted)
    for (const closeable of closeables) void closeable.close().catch(() => {})
  }
  const start = (timeoutMs?: number) => {
    if (timer) clearTimeout(timer)
    // A command may keep its environment past the run, and a deadline started then would outlive it.
    if (!active || timeoutMs === undefined) return
    timer = setTimeout(
      () =>
        abort(
          new CliError("timeout", `the command did not finish within ${timeoutMs}ms`, {
            retryable: false,
            reason: "command.timed-out",
          }),
        ),
      timeoutMs,
    )
  }
  start(timeoutMs)
  return {
    configure: (options) => {
      paths = options.fields === undefined ? undefined : fieldsOf(options.fields)
      maxOutputBytes = options.maxOutputBytes
    },
    start,
    signal: stop.signal,
    trackCloseable: (closeable: Closeable) => {
      if (closeables.has(closeable)) return
      originals.set(closeable, closeable.close)
      const close = closeable.close.bind(closeable)
      closeable.close = () => {
        let pending = closing.get(closeable)
        if (!pending) {
          pending = Promise.resolve().then(close)
          closing.set(closeable, pending)
        }
        return pending
      }
      closeables.add(closeable)
    },
    streams: {
      ...streams,
      data: (text: string) => {
        if (stop.signal.aborted) throw stop.signal.reason
        if (!active) return
        let result = text
        if (paths) {
          try {
            result = JSON.stringify(projectFields(JSON.parse(text), paths))
          } catch (error) {
            if (error instanceof CliError) throw error
            throw new CliError(
              "invalid_response",
              "this output is not a JSON result — --json=<fields> cannot pick from it",
              {
                retryable: false,
                reason: "output.fields-unavailable",
              },
            )
          }
        }
        const size = Buffer.byteLength(result) + 1
        if (maxOutputBytes !== 0 && bytes + size > maxOutputBytes)
          throw new CliError(
            "invalid_response",
            `machine output exceeds ${maxOutputBytes} bytes — reduce --limit, pick fields with --json=a,b or raise --max-output-bytes`,
            {
              retryable: false,
              reason: "output.too-large",
              max_bytes: maxOutputBytes,
              emitted_bytes: bytes,
              partial_output: bytes > 0,
            },
          )
        bytes += size
        streams.data(result)
      },
      diagnostic: (text: string) => {
        if (active) streams.diagnostic(text)
      },
    },
    race: async <T>(body: () => Promise<T>): Promise<T> => {
      const running = withWriteScope(writes, body)
      try {
        return await Promise.race([running, interruption])
      } catch (error) {
        let settled: unknown
        if (stop.signal.aborted) {
          let grace: NodeJS.Timeout | undefined
          await Promise.race([
            running.catch((own: unknown) => {
              settled = own
            }),
            new Promise<void>((resolve) => {
              grace = setTimeout(resolve, 100)
            }),
          ])
          if (grace) clearTimeout(grace)
        }
        // A command that knows its own write went out unanswered says so more precisely than a timeout.
        if (settled instanceof CliError && settled.code === "outcome_unknown") {
          interrupted = settled
          throw settled
        }
        throw interrupted ?? error
      }
    },
    abort,
    failure: () => interrupted,
    finish: async () => {
      active = false
      if (timer) clearTimeout(timer)
      {
        let grace: NodeJS.Timeout | undefined
        await Promise.race([
          Promise.allSettled([...closeables].map((one) => one.close())),
          new Promise<void>((resolve) => {
            grace = setTimeout(resolve, 1000)
          }),
        ])
        if (grace) clearTimeout(grace)
      }
      for (const [closeable, close] of originals) closeable.close = close
    },
  }
}

export const withAbort = async <T>(signal: AbortSignal | undefined, body: () => Promise<T>): Promise<T> => {
  if (!signal) return body()
  if (signal.aborted) throw signal.reason
  let abort: () => void = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
  })
  try {
    return await Promise.race([body(), interrupted])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}
