import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs"
import { dirname } from "node:path"
import { CliError, realSleep, type SleepLike } from "@wirecat/cli-base"

const LOCK_WAIT_MS = 5_000
/** Longer than any holder takes; a lock this old was left by a process that died holding it. */
const LOCK_STALE_MS = 30_000
const RETRY_MS = 20
const pause = new Int32Array(new SharedArrayBuffer(4))

/**
 * Runs `body` with `<path>.lock` held, across processes. A lock file opened with `wx`, because `flock` is not
 * there on Windows. The wait blocks the thread: only for a caller that cannot be async and never runs inside
 * `serve` — a one-shot `recipients` command, a consumer's own synchronous `SendGuard.check`.
 */
export const withFileLock = <T>(path: string, what: string, body: () => T, waitMs = LOCK_WAIT_MS): T => {
  const lock = lockFor(path)
  const deadline = Date.now() + waitMs
  while (!taken(lock)) {
    if (Date.now() >= deadline) throw lockTimeout(what, waitMs, lock)
    Atomics.wait(pause, 0, 0, RETRY_MS)
  }
  return holding(lock, body)
}

/**
 * `withFileLock` that waits on timers, so the event loop keeps running while another process holds the lock: inside
 * `serve` a blocked thread would stall every relayed command and the messenger's keep-alives. The body still runs
 * synchronously, so nothing else interleaves while the lock is held.
 */
export const withFileLockAsync = async <T>(
  path: string,
  what: string,
  body: () => T,
  waitMs = LOCK_WAIT_MS,
  sleep: SleepLike = realSleep,
): Promise<T> => {
  const lock = lockFor(path)
  const deadline = Date.now() + waitMs
  while (!taken(lock)) {
    if (Date.now() >= deadline) throw lockTimeout(what, waitMs, lock)
    await sleep(RETRY_MS)
  }
  return holding(lock, body)
}

const lockFor = (path: string): string => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  return `${path}.lock`
}

const taken = (lock: string): boolean => {
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Date.now() - lockTime(lock) <= LOCK_STALE_MS) return false
      try {
        unlinkSync(lock)
      } catch {}
    }
  }
}

const holding = <T>(lock: string, body: () => T): T => {
  try {
    return body()
  } finally {
    try {
      unlinkSync(lock)
    } catch {}
  }
}

const lockTimeout = (what: string, waitMs: number, lock: string): CliError =>
  new CliError("timeout", `${what} stayed locked for ${waitMs / 1000}s (${lock})`)

const lockTime = (lock: string): number => {
  try {
    return statSync(lock).mtimeMs
  } catch {
    return Date.now()
  }
}
