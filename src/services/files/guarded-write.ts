import { CliError, isCliError } from "@wirecat/cli-base"
import type { FileTarget, RemoteFile } from "../../documents/file-mirror-model.js"
import type { FileVersions, VersionDirection } from "./versions.js"

export interface GuardedFileWrite {
  target: FileTarget
  /** The profile's own version store, under its state folder; never inside a mirrored folder. */
  versions: FileVersions
  /** The remote path, as the target takes it. */
  path: string
  /** A local file with the new content. */
  from: string
  /** The sha256 the caller read the file at; required when a file is there, refused when none is. */
  expected?: string
  /** How the caller reads the file and its sha256 again, for the conflict's message. */
  reread: string
  /** How the replaced content is logged; `restored` when the new content is a kept version. */
  direction?: Extract<VersionDirection, "local-to-remote" | "restored">
  signal?: AbortSignal
}

export interface GuardedFileWriteResult {
  file: RemoteFile
  /** The content the write replaced, kept in `versions` before the upload. */
  replaced?: { sha256: string }
}

/** The reason of a conflict a target raised for itself, which callers pass on as it is; undefined for the usual one. */
export const ownConflict = (error: { details?: { reason?: unknown } }) => {
  const reason = error.details?.reason
  return typeof reason === "string" && reason !== "mirror.remote-changed" ? reason : undefined
}

export const remoteChanged = (path: string, why: string, reread: string) =>
  new CliError("conflict", `${path} ${why}; nothing was written. Read it again: ${reread}`, {
    reason: "mirror.remote-changed",
  })

/**
 * Writes a file only over the content the caller read. Few providers offer a conditional upload, so the current
 * content is downloaded into the version store and hashed (the proof that it is the one read), and the target checks
 * it again just before the upload. A change landing between that check and the upload is not caught: the replaced
 * content is kept, which is what makes the write safe to undo.
 */
export const guardedFileWrite = async (write: GuardedFileWrite): Promise<GuardedFileWriteResult> => {
  const { target, versions, path, from, expected, reread, direction = "local-to-remote", signal } = write
  const there = await target.exists(path, signal)
  if (there && expected === undefined)
    throw new CliError(
      "validation_error",
      `${path} exists; read it first (${reread}) and pass its sha256 as --expected-fingerprint`,
      { param: "--expected-fingerprint" },
    )
  if (!there && expected !== undefined) throw remoteChanged(path, "is no longer there", reread)
  const kept = expected === undefined ? undefined : await versions.keep((temp) => target.download(path, temp, signal))
  if (kept !== expected) throw remoteChanged(path, "changed since it was read", reread)
  let file: RemoteFile
  try {
    file = await target.upload(path, from, kept === undefined ? { absent: true } : { sha256: kept }, signal)
  } catch (error) {
    // A target's conflict with its own reason says what it did, which "nothing was written" would hide.
    if (isCliError(error) && error.code === "conflict" && ownConflict(error) === undefined)
      throw remoteChanged(path, kept === undefined ? "appeared since it was read" : "changed since it was read", reread)
    throw error
  }
  if (kept === undefined) return { file }
  versions.log({
    path,
    event: "changed",
    direction,
    old: kept,
    from: "remote",
    ...(file.sha256 ? { new: file.sha256 } : {}),
    size: file.size,
  })
  return { file, replaced: { sha256: kept } }
}
