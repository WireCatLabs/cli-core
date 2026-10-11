import { CliError } from "@wirecat/cli-base"
import { stopWrites, type WriteInFlight, withWriteScope } from "../sends/guarded.js"

/** Anything holding something that would keep the process alive — a messenger connection is one. */
export interface Closeable {
  close(): Promise<void>
}

/**
 * Stops the whole command at `ms`, and **closes what it was holding on the way out**.
 *
 * ⚠ The closing is the part that matters, and it is what a plain `Promise.race` does not do.
 * Racing only decides which answer is printed; the losing work carries on, and an open WebSocket
 * keeps Node alive — so a command that reported a timeout would then sit there, which is worse
 * than the wait it was cutting short. A test covers exactly that, by
 * taking the closing away and watching what is left behind.
 *
 * A connection closed with a request still in flight must reject that request, not strand it —
 * that is what lets the body unwind through its own `finally` rather than hanging underneath this.
 *
 * ⚠ **It bounds everything, not only what talks to the network.** A local search never opens a
 * socket at all and still has to fit the budget: an agent handing out thirty seconds does not
 * know which commands are the networked ones, and a bound that quietly did not apply to some of
 * them would be worse than no bound.
 *
 * Without a bound there is no timer and no race: the ordinary path is exactly what it was.
 */
export const withDeadline = async <T>(
  ms: number | undefined,
  closeables: Closeable[],
  body: () => Promise<T>,
): Promise<T> => {
  if (ms === undefined) return body()

  let timer: NodeJS.Timeout | undefined
  let timedOut: CliError | undefined
  const writes = new Set<WriteInFlight>()
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const pending = [...writes]
      const cut = pending.filter((write) => !write.preparing)
      timedOut =
        cut.length > 0
          ? new CliError(
              "outcome_unknown",
              `\`--timeout\` ended the command after ${ms}ms with ${cut.length === 1 ? "a write" : `${cut.length} writes`} ` +
                "in flight; the messenger may or may not have carried it out — check before repeating it",
              { operationIds: cut.map((write) => write.operationId), retryable: false },
            )
          : new CliError("timeout", `the command did not finish within ${ms}ms — \`--timeout\` ended it`)
      stopWrites(writes, timedOut)
      // Sockets first, then the message: the rejection is what the person reads, and the closing
      // is what lets the process actually end once they have read it.
      void Promise.allSettled(closeables.map((closeable) => closeable.close())).then(() => reject(timedOut))
    }, ms)
  })

  try {
    return await Promise.race([withWriteScope(writes, body), expired])
  } catch (error) {
    // Closing rejects the body's own request, and that rejection arrives first.
    throw timedOut ?? error
  } finally {
    if (timer) clearTimeout(timer)
  }
}
