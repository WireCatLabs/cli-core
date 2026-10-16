import { mkdir } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { nativeWriterLeaseStore } from "./native-writer-lease.js"
import type { WriterLease } from "./writer-lease.js"

/** A lock this process holds until it releases it. */
export interface FileLock extends WriterLease {
  /** Whether the lock on disk is still this one: check it before each write the lock guards. */
  held(): Promise<boolean>
}

/**
 * Takes the lock at `path` — a directory of PID/nonce markers beside what it guards, one per holder. A lock left
 * by a dead process on this machine is cleared first; a live one, or another machine's, refuses with the holders.
 */
export const acquireLock = async (path: string, { signal }: { signal?: AbortSignal } = {}): Promise<FileLock> => {
  const folder = dirname(path)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const acquired = await nativeWriterLeaseStore({ markerDirectory: basename(path) }).acquire(folder, {
    ...(signal ? { signal } : {}),
  })
  if (acquired.status === "acquired") return acquired.lease as FileLock
  throw new CliError("validation_error", `${basename(path)} is locked by another process`, {
    reason: "file.locked",
    ...(acquired.status === "busy" ? { holders: acquired.locks } : {}),
  })
}
