import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs"
import { dirname } from "node:path"
import { CliError } from "@wirecat/cli-base"

const LOCK_WAIT_MS = 5_000
/** Longer than any holder takes; a lock this old was left by a process that died holding it. */
const LOCK_STALE_MS = 30_000
const pause = new Int32Array(new SharedArrayBuffer(4))

/**
 * Runs `body` with `<path>.lock` held, across processes. A lock file opened with `wx`, because `flock` is not
 * there on Windows.
 */
export const withFileLock = <T>(path: string, what: string, body: () => T, waitMs = LOCK_WAIT_MS): T => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lock = `${path}.lock`
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Date.now() - lockTime(lock) > LOCK_STALE_MS) {
        try {
          unlinkSync(lock)
        } catch {}
        continue
      }
      if (Date.now() >= deadline) throw new CliError("timeout", `${what} stayed locked for ${waitMs / 1000}s (${lock})`)
      Atomics.wait(pause, 0, 0, 20)
    }
  }
  try {
    return body()
  } finally {
    try {
      unlinkSync(lock)
    } catch {}
  }
}

const lockTime = (lock: string): number => {
  try {
    return statSync(lock).mtimeMs
  } catch {
    return Date.now()
  }
}
