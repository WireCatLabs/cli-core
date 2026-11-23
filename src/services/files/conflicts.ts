import { existsSync } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import { dirname, join, posix } from "node:path"
import { CliError } from "@wirecat/cli-base"
import type { Expect, FileConflict, FileMirrorStatePort, RemoteFile } from "../../documents/file-mirror-model.js"
import type { Keep } from "../../documents/push-model.js"
import { type HeldLock, heldCheck, type Mirror } from "../documents/mirrors.js"
import { assertNoLink, hashFile, safePath } from "../documents/push.js"
import { copyName, trashLocal } from "./local-files.js"
import type { FileMirrorOptions } from "./mirror.js"
import { conflictText, mergeable, mergeText, type TextSegment } from "./text-merge.js"
import type { FileVersions, VersionParts } from "./versions.js"

/** The conflicts each mirror's last sync left, by mirror and path. */
export const listFileConflicts = (mirrors: Mirror[], stateOf: (mirror: Mirror) => FileMirrorStatePort) =>
  mirrors.flatMap((mirror) =>
    Object.entries(stateOf(mirror).read().conflicts ?? {}).map(([path, found]) => ({
      id: mirror.id,
      path,
      reason: found.reason,
      at: found.at,
      kept: found.kept === true,
      local: found.local ?? null,
      remote: found.remote ?? null,
    })),
  )

const recorded = (state: FileMirrorStatePort, path: string): FileConflict => {
  const found = state.read().conflicts?.[path]
  if (!found)
    throw new CliError("not_found", `${path} has no conflict; the last sync settled it or never saw one`, {
      reason: "mirror.no-conflict",
    })
  return found
}

export interface FileConflictVersion {
  sha256: string | null
  available: boolean
  /** The content as text, when the store has it and the file is text a merge reads. */
  text?: string
}

export interface FileConflictView {
  path: string
  reason: string
  at: string
  base: FileConflictVersion
  local: FileConflictVersion
  remote: FileConflictVersion
  /** The local file was changed since the conflict was found: a resolution is refused until a sync sees it. */
  localChanged: boolean
  /** Each changed stretch of the line merge, conflicts included; empty when the versions are not all kept text. */
  hunks: TextSegment[]
  /** The whole file as the merge would write it, with Git's markers around each conflict: a start for `--file`. */
  merged?: string
}

/** A recorded conflict with its three versions and, for kept text, the line merge that failed. */
export const showFileConflict = async (options: {
  root: string
  path: string
  state: FileMirrorStatePort
  versions: FileVersions
  /** How the app names the remote side in the conflict markers. */
  remote: string
}): Promise<FileConflictView> => {
  const { root, path, versions } = options
  if (!safePath(path)) throw new CliError("validation_error", `${path} is not a path inside the mirror`)
  const found = recorded(options.state, path)
  const read = async (sha256?: string) => (sha256 ? await versions.read(sha256) : undefined)
  const [base, local, remote] = await Promise.all([read(found.base), read(found.local), read(found.remote)])
  const text = mergeable(path, ...[base, local, remote].map((bytes) => bytes?.length ?? 0))
  const version = (sha256: string | undefined, bytes: Buffer | undefined): FileConflictVersion => ({
    sha256: sha256 ?? null,
    available: sha256 === undefined || bytes !== undefined,
    ...(text && bytes ? { text: bytes.toString("utf8") } : {}),
  })
  await assertNoLink(root, path)
  const absolute = join(root, path)
  const now = existsSync(absolute) ? (await hashFile(absolute)).sha256 : undefined
  const view: FileConflictView = {
    path,
    reason: found.reason,
    at: found.at,
    base: version(found.base, base),
    local: version(found.local, local),
    remote: version(found.remote, remote),
    localChanged: now !== found.local,
    hunks: [],
  }
  if (!text || !base || !local || !remote) return view
  const merge = await mergeText(path, base, local, remote)
  view.hunks = merge.segments.filter((segment) => segment.kind !== "same")
  view.merged = conflictText(merge.segments, options.remote)
  return view
}

export interface FileConflictResolveOptions
  extends Pick<FileMirrorOptions, "target" | "principal" | "guard" | "operationId" | "signal" | "now"> {
  root: string
  folder: string
  path: string
  state: FileMirrorStatePort
  versions: FileVersions
  /** How the app names the remote side; it ends a kept copy's name. */
  remote: string
  /** The mirrors' sync lock, as `acquireLock` returns it. */
  lock(): Promise<HeldLock>
  /** Keep one side or both whole, or `file`: the absolute path of the final content, written to both sides. */
  choice: { keep: Keep } | { file: string }
}

export interface FileConflictResolution {
  path: string
  resolution: "local" | "remote" | "both" | "file"
  /** The content both sides now have; null when the resolution deleted the file. */
  sha256: string | null
  /** The remote version's copy beside the local file, for `keep: "both"`. */
  copy?: string
}

const changed = (what: string, reason: string) =>
  new CliError("conflict", `${what} changed since the conflict was found; nothing was written. Sync again to see it`, {
    reason,
  })

/**
 * Settles a recorded conflict with the owner's choice, on both sides at once. Both sides are checked against what the
 * conflict recorded: the local file by its hash, the remote by an upload or trash that expects its hash, made before
 * the local file is touched, so a remote changed meanwhile refuses the resolution with nothing written. Every content
 * replaced was kept by the conflict or is kept first, and the resolution is logged with all of them, kept for good.
 * Runs under the mirrors' sync lock.
 */
export const resolveFileConflict = async (options: FileConflictResolveOptions): Promise<FileConflictResolution> => {
  const { root, folder, path, target, versions, choice, signal } = options
  if (!safePath(path)) throw new CliError("validation_error", `${path} is not a path inside the mirror`)
  const now = options.now ?? Date.now
  const held = await options.lock()
  try {
    const assertHeld = heldCheck(held)
    if ((await target.identity()) !== options.principal)
      throw new CliError("authentication_error", "signed-in account does not match this profile", {
        reason: "profile.wrong-account",
      })
    const found = recorded(options.state, path)
    await assertNoLink(root, path)
    const absolute = join(root, path)
    await mkdir(dirname(absolute), { recursive: true })
    const remotePath = (at: string) => posix.join(folder, at)
    const localNow = existsSync(absolute) ? await versions.keep(absolute) : undefined
    if (localNow !== found.local) throw changed("the local file", "mirror.local-changed")
    if (found.remote && !versions.has(found.remote)) {
      const got = await versions.keep((temp) => target.download(remotePath(path), temp, signal))
      if (got !== found.remote) throw changed(`the ${options.remote} file`, "mirror.remote-changed")
    }
    const supplied = "file" in choice ? await versions.keep(choice.file) : undefined
    const keep = "keep" in choice ? choice.keep : undefined
    const final =
      supplied ?? (keep === "remote" ? found.remote : keep === "local" ? found.local : (found.local ?? found.remote))
    const date = new Date(now()).toISOString().slice(0, 10)
    const write = async <T>(
      action: Parameters<FileMirrorOptions["guard"]>[0]["action"],
      side: "local" | "remote",
      at: string,
      act: () => Promise<T>,
    ) => {
      await assertHeld()
      return options.guard({ action, side, path: at, operationId: options.operationId() }, act)
    }
    const send = async (at: string, from: string, hash: string, expect: Expect) => {
      const parent = posix.dirname(at)
      if (parent !== ".") await write("folder", "remote", parent, () => target.ensureFolder(remotePath(parent), signal))
      const sent = await write("absent" in expect ? "create" : "update", "remote", at, () =>
        target.upload(remotePath(at), from, expect, signal),
      )
      if (sent.sha256 !== undefined && sent.sha256 !== hash)
        throw new CliError("conflict", "the file changed during the upload", { reason: "upload.mismatch" })
      return sent
    }
    const expectRemote: Expect = found.remote
      ? { sha256: found.remote, ...(found.remoteFile?.md5 ? { md5: found.remoteFile.md5 } : {}) }
      : { absent: true }

    let sent: RemoteFile | undefined = final === found.remote ? found.remoteFile : undefined
    if (final !== found.remote) {
      if (final === undefined) {
        await write("delete", "remote", path, () =>
          target.trash(remotePath(path), expectRemote as Exclude<Expect, { absent: true }>, signal),
        )
      } else sent = await send(path, "file" in choice ? choice.file : absolute, final, expectRemote)
    }
    if (final !== found.local) {
      const placed =
        final === undefined
          ? await write("delete", "local", path, () => trashLocal(root, path, found.local as string, date))
          : await write(found.local ? "update" : "create", "local", path, () =>
              versions.write(final, absolute, found.local),
            )
      if (!placed) throw changed("the local file", "mirror.local-changed")
    }

    let copy: string | undefined
    const state = options.state.read()
    const entry = async (at: string, file: RemoteFile, sha256: string) => {
      const { size, mtimeMs } = await stat(join(root, at))
      state.entries[at] = {
        id: file.id,
        size: file.size,
        sha256,
        ...(file.md5 ? { md5: file.md5 } : {}),
        remoteModified: file.modifiedAt,
        localMtimeMs: mtimeMs,
        localSize: size,
        syncedAt: new Date(now()).toISOString(),
      }
    }
    if (final === undefined) delete state.entries[path]
    else if (sent) await entry(path, sent, final)
    if (keep === "both" && found.local && found.remote) {
      const name = copyName(path, options.remote, date, (at) => existsSync(join(root, at)) || at in state.entries)
      await assertNoLink(root, name)
      if (!(await write("create", "local", name, () => versions.write(found.remote as string, join(root, name)))))
        throw changed("the local folder", "mirror.local-changed")
      await entry(name, await send(name, join(root, name), found.remote, { absent: true }), found.remote)
      copy = name
    }
    if (state.conflicts) {
      delete state.conflicts[path]
      if (!Object.keys(state.conflicts).length) delete state.conflicts
    }
    options.state.save(state)
    const parts: VersionParts = {
      ...(found.base ? { base: found.base } : {}),
      ...(found.local ? { local: found.local } : {}),
      ...(found.remote ? { remote: found.remote } : {}),
    }
    const resolution = keep ?? "file"
    versions.log({
      path,
      event: "resolved",
      direction: "both",
      parts,
      ...(final ? { new: final } : {}),
      resolution,
    })
    return { path, resolution, sha256: final ?? null, ...(copy ? { copy } : {}) }
  } finally {
    await held.release()
  }
}
