import { createHash } from "node:crypto"
import { mkdir, rm, stat, unlink } from "node:fs/promises"
import { dirname, join, posix } from "node:path"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import type {
  Expect,
  FileEntry,
  FileMirrorState,
  FileMirrorStatePort,
  FileStepKind,
  FileTarget,
  RemoteFile,
} from "../../documents/file-mirror-model.js"
import type { Keep, LocalDocument } from "../../documents/push-model.js"
import { eachMirror, jsonState, type Mirror } from "../documents/mirrors.js"
import {
  assertNoLink,
  hashFile,
  localTemp,
  type MirrorAction,
  type PushConflict,
  placeNew,
  replaceLocal,
  safePath,
  scanLocal,
  skippedName,
} from "../documents/push.js"
import type { FileVersions } from "./versions.js"

type Local = LocalDocument & { size: number; mtimeMs: number }
type Side = "local" | "remote"

export interface FileMirrorOptions {
  /** Absolute path of the local folder. */
  root: string
  /** The remote folder, as the target addresses it. */
  folder: string
  target: FileTarget
  state: FileMirrorStatePort
  /** Keeps every local file's content before the sync overwrites or deletes it, and logs each change. */
  versions: FileVersions
  principal: string
  /** Settles conflicts; without it they are reported and left. */
  keep?: Keep
  dryRun?: boolean
  /** Lets a run delete this many files although the deletion guard would stop it. */
  allowDeletions?: number
  /**
   * The owner confirmed that a root reported as replaced is the right folder now: its identity is recorded again and
   * the run is a first sync (identical files adopted, different ones conflicts), deleting nothing.
   */
  repin?: boolean
  /** How the app names the remote side; it ends a conflict copy's name. */
  remote: string
  /** Runs one write behind the app's permission checks; `side` says which side it changes. */
  guard<T>(
    attempt: { action: MirrorAction; side: Side; path: string; operationId: string },
    act: () => Promise<T>,
  ): Promise<T>
  operationId(): string
  errorOf(error: unknown): CliError
  assertHeld(): void
  signal?: AbortSignal
  maxFiles?: number
  now?(): number
}

export interface FileStep {
  kind: FileStepKind
  path: string
  /** A rename's new path, or a kept copy's name. */
  to?: string
}

export interface FileMirrorResult {
  uploaded: string[]
  downloaded: string[]
  trashed: { path: string; side: Side }[]
  renamed: { from: string; to: string }[]
  adopted: string[]
  unchanged: number
  conflicts: PushConflict[]
  errors: { path: string; code: string; message: string }[]
  /**
   * Files of the last sync missing from a side that cannot prove a deletion: its listing was incomplete, or its root
   * is gone or is another folder. Nothing is deleted for them.
   */
  unknown: { path: string; side: Side; reason: string }[]
  /** Every step but the unchanged files, on a dry run. */
  plan?: FileStep[]
  /** On a dry run, the deletions that would stop the real run without `allowDeletions`. */
  tooManyDeletions?: number
  stopped?: true
}

interface Step extends FileStep {
  local?: Local
  remote?: RemoteFile
  base?: FileEntry
  reason?: string
  /** Why an `unknown` step cannot prove a deletion, when it is not an incomplete remote listing. */
  why?: string
}

/**
 * A run that would delete more than `ALWAYS_DELETED` files and more than `MAX_DELETIONS` files or `MAX_DELETED_SHARE`
 * of the mirror stops before writing.
 */
const ALWAYS_DELETED = 2
const MAX_DELETIONS = 50
const MAX_DELETED_SHARE = 0.25
const TRASH = ".wirecat-trash"
const SAVE_EVERY_MS = 1_000

/** A temporary file's tag from any operation id, safe in a file name. */
const tagOf = (operationId: string) => createHash("sha256").update(operationId).digest("hex").slice(0, 8)

const sameFile = (local: Local, remote: RemoteFile) => local.hash === remote.sha256

/**
 * The three-way comparison of one path: the local file now, the remote file now and the last sync. A side is
 * "same" when its content still has the last sync's hash.
 */
const decide = (
  path: string,
  sure: Record<Side, boolean>,
  local?: Local,
  remote?: RemoteFile,
  base?: FileEntry,
  keep?: Keep,
): Step | undefined => {
  const step = (kind: FileStepKind, reason?: string): Step => ({
    kind,
    path,
    ...(local ? { local } : {}),
    ...(remote ? { remote } : {}),
    ...(base ? { base } : {}),
    ...(reason ? { reason } : {}),
  })
  // Only a file the last sync saw, missing from a complete listing of the same root, counts as deleted.
  if (base && !local && !sure.local) return step("unknown", "local")
  if (base && !remote && !sure.remote) return step("unknown", "remote")
  if (!local && !remote) return base ? step("forget") : undefined
  if (local && remote && sameFile(local, remote))
    return base?.sha256 === local.hash && base.id === remote.id ? undefined : step("adopt")
  if (!base) {
    if (!remote) return step("upload")
    if (!local) return step("download")
    return settle("created on both sides with different content", "upload", "download", "keep-both")
  }
  const localSame = local?.hash === base.sha256
  const remoteSame = remote?.sha256 === base.sha256
  if (localSame) return step(remote ? "download" : "trash-local")
  if (remoteSame) return step(local ? "upload" : "trash-remote")
  if (!local) return settle("deleted here, changed on the remote", "trash-remote", "download", "download")
  if (!remote) return settle("changed here, deleted on the remote", "upload", "trash-local", "upload")
  return settle("changed on both sides", "upload", "download", "keep-both")

  function settle(reason: string, ...[ifLocal, ifRemote, ifBoth]: [FileStepKind, FileStepKind, FileStepKind]) {
    if (keep === "local") return step(ifLocal)
    if (keep === "remote") return step(ifRemote)
    if (keep === "both") return step(ifBoth)
    return step("conflict", reason)
  }
}

/** `name (conflict 2026-11-18 disk).ext`, numbered when that name is taken. */
const copyName = (path: string, remote: string, date: string, taken: (path: string) => boolean) => {
  const extension = posix.extname(path)
  const stem = path.slice(0, path.length - extension.length)
  for (let n = 1; ; n++) {
    const candidate = `${stem} (conflict ${date} ${remote}${n > 1 ? ` ${n}` : ""})${extension}`
    if (!taken(candidate)) return candidate
  }
}

/** Moves a file into `<root>/.wirecat-trash/<date>/` while it still has `hash`; false when it changed. */
const trashLocal = async (root: string, path: string, hash: string, date: string) => {
  await assertNoLink(root, path)
  await assertNoLink(root, posix.join(TRASH, date, path))
  const from = join(root, path)
  if ((await hashFile(from)).sha256 !== hash) return false
  const into = join(root, TRASH, date, path)
  await mkdir(dirname(into), { recursive: true })
  for (let n = 1; ; n++) {
    try {
      await placeNew(from, n > 1 ? `${into}.${n}` : into)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  await unlink(from)
  return true
}

/** Renames a local file while it still has `hash` and nothing holds the new name; false otherwise. */
const renameLocal = async (root: string, from: string, to: string, hash: string) => {
  await assertNoLink(root, from)
  await assertNoLink(root, to)
  const source = join(root, from)
  if ((await hashFile(source)).sha256 !== hash) return false
  await mkdir(dirname(join(root, to)), { recursive: true })
  try {
    await placeNew(source, join(root, to))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
  await unlink(source)
  return true
}

/** Every local file, hashed only when its size or mtime moved since the last sync. */
const scan = async (root: string, entries: Record<string, FileEntry>, maxFiles?: number) => {
  const { files, links } = await scanLocal(
    root,
    () => "file",
    maxFiles,
    (path) => {
      const entry = entries[path]
      return entry && { size: entry.localSize, mtimeMs: entry.localMtimeMs, hash: entry.sha256 }
    },
  )
  return { files: files as Local[], links }
}

/** Remote files the mirror covers: hidden files and editor leftovers are skipped, as they are locally. */
const mirrored = (files: RemoteFile[]) => files.filter((file) => !file.path.split("/").some(skippedName))

/** True when `path` is `link` or lies under it. */
const under = (path: string, link: string) => path === link || path.startsWith(`${link}/`)

/**
 * Syncs a local folder and a remote folder of plain files both ways, whole files at a time. Each path is compared
 * three ways (local now, remote now, last sync): a change on one side is copied to the other, the same content on
 * both is adopted, and different changes on both are a conflict unless `keep` settles it. Deletions go to the
 * remote's trash and to `<root>/.wirecat-trash/`. A remote rename, found by the file's id, renames the local file.
 * Every write is conditional on what the listing saw, so a crash at any point is settled by the next run.
 */
export const syncFileMirror = async (options: FileMirrorOptions): Promise<FileMirrorResult> => {
  const { root, folder, target, principal, keep, signal, versions } = options
  const now = options.now ?? Date.now
  if (signal?.aborted) throw new CliError("cancelled", "sync was cancelled")
  if ((await target.identity()) !== principal)
    throw new CliError("authentication_error", "signed-in account does not match this profile", {
      reason: "profile.wrong-account",
    })
  const state = options.state.read()
  if (state.principal !== principal || state.root !== root || state.target !== folder)
    throw new CliError("configuration_error", "mirror state belongs to another account or mirror")
  const repin = options.repin === true
  // A re-pinned mirror starts over: the last sync's entries describe the folder it replaced.
  const entries = repin ? {} : state.entries
  const synced = Object.keys(entries).length > 0
  const listed = await target.list(folder, signal)
  const localRoot = await stat(root).catch(() => undefined)
  const scanned = localRoot?.isDirectory() ? await scan(root, entries, options.maxFiles) : { files: [], links: [] }
  const local = new Map(scanned.files.map((file) => [file.path, file]))
  const problem = (side: Side, code: string, reason: string, repinnable = false) => ({ side, code, reason, repinnable })
  // A folder that is gone, replaced, or empty where the state had files (an unmounted drive) is not this mirror.
  const rootProblem = !listed
    ? problem("remote", "not_found", `the ${options.remote} folder is gone`)
    : !repin && state.rootId !== undefined && listed.rootId !== state.rootId
      ? problem("remote", "confirmation_required", `the ${options.remote} folder was replaced by another one`, true)
      : !localRoot?.isDirectory()
        ? problem("local", "not_found", "the local folder is gone")
        : !repin && state.localRoot && (state.localRoot.dev !== localRoot.dev || state.localRoot.ino !== localRoot.ino)
          ? problem("local", "confirmation_required", "the local folder was replaced by another one", true)
          : synced && !local.size
            ? problem("local", "validation_error", "the local folder is empty; it may be an unmounted drive")
            : undefined
  const refused = rootProblem ? [] : (listed?.files ?? []).filter((file) => !safePath(file.path))
  const remote = new Map(
    rootProblem
      ? []
      : mirrored((listed?.files ?? []).filter((file) => safePath(file.path))).map((file) => [file.path, file]),
  )
  const sure = {
    local: rootProblem?.side !== "local",
    // A listing with a path the mirror cannot use may hide where a file went.
    remote: rootProblem?.side !== "remote" && listed?.complete === true && !refused.length,
  }
  const base = { ...entries }

  const steps: Step[] = []
  const byId = new Map([...remote.values()].map((file) => [file.id, file]))
  for (const [path, entry] of Object.entries(entries)) {
    const moved = remote.has(path) ? undefined : byId.get(entry.id)
    const file = local.get(path)
    if (!moved || base[moved.path] || local.has(moved.path) || file?.hash !== entry.sha256) continue
    steps.push({ kind: "rename-local", path, to: moved.path, local: file, base: entry })
    base[moved.path] = entry
    delete base[path]
    local.delete(path)
    local.set(moved.path, { ...file, path: moved.path, absolute: join(root, moved.path) })
  }

  let unchanged = 0
  const touched: string[] = []
  const paths = [...new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)])].sort()
  const result: FileMirrorResult = {
    uploaded: [],
    downloaded: [],
    trashed: [],
    renamed: [],
    adopted: [],
    unchanged: 0,
    conflicts: [],
    errors: [],
    unknown: [],
  }
  if (rootProblem) {
    const { side, code, reason, repinnable } = rootProblem
    result.unknown = Object.keys(state.entries).map((path) => ({ path, side, reason }))
    result.errors.push({
      path: ".",
      code,
      message: repinnable
        ? `${reason}; if it is the right folder now, sync again with --repin to record it (that run deletes nothing)`
        : reason,
    })
    return result
  }
  for (const file of refused)
    result.errors.push({
      path: file.path,
      code: "invalid_response",
      message: `the ${options.remote} listed a path the mirror cannot use`,
    })
  for (const path of paths) {
    if (base[path] && !local.has(path) && scanned.links.some((link) => under(path, link))) {
      steps.push({
        kind: "unknown",
        path,
        reason: "local",
        why: "under a symbolic link, which the sync does not follow",
      })
      continue
    }
    const file = remote.get(path)
    if (file && file.sha256 === undefined) {
      result.errors.push({ path, code: "provider_error", message: `the ${options.remote} has no hash for it yet` })
      continue
    }
    const step = decide(path, sure, local.get(path), file, base[path], keep)
    if (step) steps.push(step)
    else unchanged++
    const entry = base[path]
    const here = local.get(path)
    // Saved without a write, so the next scan does not read a file only touched since the last sync.
    if (!step && entry && here && (entry.localMtimeMs !== here.mtimeMs || entry.localSize !== here.size))
      touched.push(path)
  }
  result.unchanged = unchanged
  const conflict = (step: Step, reason: string) =>
    result.conflicts.push({
      path: step.path,
      reason,
      ...(step.local ? { localChangedAt: new Date(step.local.mtimeMs).toISOString(), localSize: step.local.size } : {}),
      ...(step.remote ? { remoteChangedAt: step.remote.modifiedAt, remoteSize: step.remote.size } : {}),
    })
  for (const step of steps) {
    if (step.kind === "conflict") conflict(step, step.reason ?? "")
    if (step.kind === "unknown")
      result.unknown.push({
        path: step.path,
        side: step.reason as Side,
        reason: step.why ?? `missing from an incomplete ${options.remote} listing`,
      })
  }

  const deletions = steps.filter((step) => step.kind === "trash-local" || step.kind === "trash-remote").length
  const tooMany =
    deletions > ALWAYS_DELETED &&
    (deletions > MAX_DELETIONS || deletions > Object.keys(state.entries).length * MAX_DELETED_SHARE)
  if (options.dryRun) {
    result.plan = steps.map(({ kind, path, to }) => ({ kind, path, ...(to ? { to } : {}) }))
    if (tooMany) result.tooManyDeletions = deletions
    return result
  }
  if (tooMany && (options.allowDeletions ?? 0) < deletions)
    throw new CliError(
      "confirmation_required",
      `this sync would delete ${deletions} files; check them with --dry-run and allow them explicitly`,
      { reason: "mirror.too-many-deletions", deletions },
    )

  if (repin) {
    state.entries = {}
    state.rootId = listed?.rootId
    if (localRoot) state.localRoot = { dev: localRoot.dev, ino: localRoot.ino }
  } else {
    state.rootId ??= listed?.rootId
    if (localRoot) state.localRoot ??= { dev: localRoot.dev, ino: localRoot.ino }
  }
  for (const [path, pending] of Object.entries(state.pending)) {
    if (pending.op === "download") await rm(localTemp(join(root, path), tagOf(pending.operationId)), { force: true })
    delete state.pending[path]
  }
  let savedAt = now()
  const save = (force = false) => {
    if (!force && now() - savedAt < SAVE_EVERY_MS) return
    options.state.save(state)
    savedAt = now()
  }
  for (const path of touched) {
    const here = local.get(path)
    const entry = state.entries[path]
    if (here && entry) state.entries[path] = { ...entry, localMtimeMs: here.mtimeMs, localSize: here.size }
  }
  save(true)

  const date = new Date(now()).toISOString().slice(0, 10)
  const remotePath = (path: string) => posix.join(folder, path)
  const folders = new Set([...remote.keys()].map((path) => posix.dirname(path)))
  for (const path of [...folders]) for (let up = path; up !== "."; up = posix.dirname(up)) folders.add(up)
  let lastOperation = ""
  const write = <T>(action: MirrorAction, side: Side, path: string, act: () => Promise<T>, operationId?: string) => {
    options.assertHeld()
    lastOperation = operationId ?? options.operationId()
    return options.guard({ action, side, path, operationId: lastOperation }, act)
  }
  const record = (path: string, file: RemoteFile, placed: { size: number; mtimeMs: number }, sha256: string) => {
    state.entries[path] = {
      id: file.id,
      size: file.size,
      sha256,
      ...(file.md5 ? { md5: file.md5 } : {}),
      remoteModified: file.modifiedAt,
      localMtimeMs: placed.mtimeMs,
      localSize: placed.size,
      syncedAt: new Date(now()).toISOString(),
    }
    save()
  }

  const upload = async (path: string, from: Local, expect: Expect, created: boolean) => {
    for (const up of ancestors(path))
      if (!folders.has(up)) {
        await write("folder", "remote", up, () => target.ensureFolder(remotePath(up), signal))
        folders.add(up)
      }
    const sent = await write(created ? "create" : "update", "remote", path, () =>
      target.upload(remotePath(path), from.absolute, expect, signal),
    )
    if (sent.sha256 !== undefined && sent.sha256 !== from.hash)
      throw new CliError("conflict", "the local file changed during the upload", { reason: "upload.mismatch" })
    record(path, sent, from, from.hash)
    versions.log({
      path,
      event: created ? "created" : "changed",
      direction: "local-to-remote",
      ...("sha256" in expect ? { old: expect.sha256 } : {}),
      new: from.hash,
      size: from.size,
    })
    result.uploaded.push(path)
  }
  /**
   * False when the local file changed (or appeared) during the sync, so nothing was written. Without `recorded`, the
   * caller records the file once it is on both sides.
   */
  const download = async (path: string, file: RemoteFile, over?: Local, recorded = true) => {
    const operationId = options.operationId()
    state.pending[path] = { op: "download", operationId }
    save(true)
    const absolute = join(root, path)
    await assertNoLink(root, path)
    await mkdir(dirname(absolute), { recursive: true })
    const old = over ? await versions.keep(absolute) : undefined
    const written = await write(
      over ? "update" : "create",
      "local",
      path,
      () =>
        replaceLocal(absolute, over?.hash, (temp) => target.download(remotePath(file.path), temp, signal), {
          tag: tagOf(operationId),
          sha256: file.sha256 as string,
        }),
      operationId,
    )
    delete state.pending[path]
    if (!written) return false
    if (recorded) record(path, file, await stat(absolute), written.sha256)
    versions.log({
      path,
      event: old ? "changed" : "created",
      direction: "remote-to-local",
      ...(old ? { old } : {}),
      new: written.sha256,
      size: file.size,
    })
    result.downloaded.push(path)
    return true
  }
  const expectOf = (file?: RemoteFile): Expect =>
    file ? { sha256: file.sha256 as string, ...(file.md5 ? { md5: file.md5 } : {}) } : { absent: true }
  const changedHere = (step: Step) => conflict(step, "the local file changed during the sync")

  const run = async (step: Step) => {
    const { path, local: here, remote: there, base: last } = step
    switch (step.kind) {
      case "conflict":
        return
      case "adopt":
        if (here && there) record(path, there, here, here.hash)
        result.adopted.push(path)
        return
      case "forget":
        delete state.entries[path]
        save()
        return
      case "upload":
        if (here) await upload(path, here, expectOf(there), !there)
        return
      case "download":
        if (there && !(await download(path, there, here))) changedHere(step)
        return
      case "trash-remote":
        if (!there) return
        await write("delete", "remote", path, () =>
          target.trash(
            remotePath(path),
            { sha256: there.sha256 as string, ...(there.md5 ? { md5: there.md5 } : {}) },
            signal,
          ),
        )
        delete state.entries[path]
        save()
        versions.log({
          path,
          event: "deleted",
          direction: "local-to-remote",
          old: there.sha256 as string,
          size: there.size,
        })
        result.trashed.push({ path, side: "remote" })
        return
      case "trash-local": {
        if (!here) return
        const old = await versions.keep(here.absolute)
        if (!(await write("delete", "local", path, () => trashLocal(root, path, here.hash, date))))
          return changedHere(step)
        delete state.entries[path]
        save()
        versions.log({ path, event: "deleted", direction: "remote-to-local", old, size: here.size })
        result.trashed.push({ path, side: "local" })
        return
      }
      case "rename-local": {
        const to = step.to as string
        if (!last || !(await write("move", "local", to, () => renameLocal(root, path, to, last.sha256))))
          return changedHere(step)
        const placed = await stat(join(root, to))
        state.entries[to] = { ...last, localMtimeMs: placed.mtimeMs, localSize: placed.size }
        delete state.entries[path]
        save()
        versions.log({ path, event: "renamed", direction: "remote-to-local", to, new: last.sha256, size: last.size })
        result.renamed.push({ from: path, to })
        return
      }
      case "keep-both": {
        if (!here || !there) return
        // The remote version lands beside the local one first, so the overwrite below loses nothing. The copy is
        // recorded only by its upload: recorded earlier, a failed upload would make it look deleted remotely.
        const copy = copyName(path, options.remote, date, (name) => local.has(name) || remote.has(name))
        if (!(await download(copy, there, undefined, false))) return changedHere(step)
        await upload(path, here, expectOf(there), false)
        const { size, mtimeMs } = await stat(join(root, copy))
        const copied = { ...here, path: copy, absolute: join(root, copy), hash: there.sha256 as string, size, mtimeMs }
        await upload(copy, copied, { absent: true }, true)
        return
      }
    }
  }

  try {
    for (const step of steps) {
      if (signal?.aborted) {
        result.stopped = true
        break
      }
      try {
        await run(step)
      } catch (error) {
        const failure = options.errorOf(error)
        if (failure.code === "cancelled") {
          result.stopped = true
          break
        }
        if (failure.code === "conflict")
          conflict(
            step,
            failure.details?.reason === "upload.mismatch"
              ? failure.message
              : `the ${options.remote} file changed during the sync`,
          )
        else result.errors.push({ path: step.path, code: failure.code, message: failure.message })
        // Not retried: the next listing shows whether it landed, and adopts it when it did.
        if (failure.code === "outcome_unknown") state.pending[step.path] = { op: step.kind, operationId: lastOperation }
      }
    }
  } finally {
    save(true)
  }
  options.assertHeld()
  await versions.prune()
  return result
}

const ancestors = (path: string) => {
  const found: string[] = []
  for (let up = posix.dirname(path); up !== "."; up = posix.dirname(up)) found.unshift(up)
  return found
}

const entrySchema = v.object({
  id: v.string(),
  size: v.number(),
  sha256: v.string(),
  md5: v.optional(v.string()),
  remoteModified: v.string(),
  localMtimeMs: v.number(),
  localSize: v.number(),
  syncedAt: v.string(),
})
const stateSchema = v.object({
  version: v.literal(1),
  principal: v.string(),
  root: v.string(),
  target: v.string(),
  rootId: v.optional(v.string()),
  localRoot: v.optional(v.object({ dev: v.number(), ino: v.number() })),
  entries: v.record(v.string(), entrySchema),
  pending: v.record(v.string(), v.object({ op: v.string(), operationId: v.string() })),
})

/** A file mirror's state in `<dir>/<id>.json`, refused rather than reset when invalid. */
export const fileSyncState = (dir: string, mirror: Mirror, principal: string): FileMirrorStatePort =>
  jsonState<FileMirrorState>(join(dir, `${mirror.id}.json`), stateSchema, () => ({
    version: 1,
    principal,
    root: mirror.path,
    target: mirror.folder,
    entries: {},
    pending: {},
  }))

/** What each mirror's next sync would send from local changes alone; the remote is not asked. */
export const fileMirrorStatus = async (mirrors: Mirror[], stateOf: (mirror: Mirror) => FileMirrorStatePort) => {
  const items = []
  for (const mirror of mirrors) {
    const { entries } = stateOf(mirror).read()
    const { files, links } = await scan(mirror.path, entries)
    const seen = new Set(files.map((file) => file.path))
    items.push({
      id: mirror.id,
      path: mirror.path,
      folder: mirror.folder,
      upload: files.filter((file) => entries[file.path]?.sha256 !== file.hash).map((file) => file.path),
      delete: Object.keys(entries).filter((path) => !seen.has(path) && !links.some((link) => under(path, link))),
      unchanged: files.length - files.filter((file) => entries[file.path]?.sha256 !== file.hash).length,
      remote_checked: false,
    })
  }
  return items
}

/**
 * A watch's `remoteChanges` for a file target: every mirror when the remote's revision moved since the last poll (or
 * at the first poll), none when it did not, and every mirror at each poll when the target has no revision.
 */
export const fileRemoteChanges = (target: FileTarget) => {
  let last: string | undefined
  return async (signal: AbortSignal): Promise<string[] | "all"> => {
    if (!target.revision) return "all"
    const revision = await target.revision(signal)
    const moved = revision !== last
    last = revision
    return moved ? "all" : []
  }
}

export interface FileMirrorSyncOptions
  extends Pick<
    FileMirrorOptions,
    | "target"
    | "principal"
    | "keep"
    | "dryRun"
    | "allowDeletions"
    | "repin"
    | "guard"
    | "operationId"
    | "errorOf"
    | "signal"
  > {
  mirrors: Mirror[]
  stateOf(mirror: Mirror): FileMirrorStatePort
  versionsOf(mirror: Mirror): FileVersions
  lock(): Promise<{ assertHeld(): void; release(): Promise<void> | void }>
  /** How the app names the remote side in reports and conflict copies. */
  remote: string
}

/** Syncs each file mirror under one lock, with one `mirror.partial` issue per mirror left with conflicts or errors. */
export const syncFileMirrors = (options: FileMirrorSyncOptions) =>
  eachMirror(options.mirrors, options.lock, options.remote, (mirror, assertHeld) =>
    syncFileMirror({
      ...options,
      root: mirror.path,
      folder: mirror.folder,
      state: options.stateOf(mirror),
      versions: options.versionsOf(mirror),
      assertHeld,
    }),
  )
