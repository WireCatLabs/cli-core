import { createHash } from "node:crypto"
import { mkdir, rm, stat, statfs, unlink } from "node:fs/promises"
import { dirname, join, posix } from "node:path"
import { CliError, isCliError } from "@wirecat/cli-base"
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
import { eachMirror, type HeldLock, heldCheck, jsonState, type Mirror } from "../documents/mirrors.js"
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
import { excludedBy } from "./exclusions.js"
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
  /**
   * Keeps every content before the sync overwrites or deletes it (a remote one an upload replaces is downloaded first
   * unless the store has it; a remote deletion leaves it in the provider's trash), and logs each change.
   */
  versions: FileVersions
  principal: string
  /** Settles conflicts; without it they are reported and left. */
  keep?: Keep
  dryRun?: boolean
  /** Lets a run delete this many files although the guard would stop it. */
  allowDeletions?: number
  /** Lets a run replace this many existing files, on either side, although the guard would stop it. */
  allowReplacements?: number
  /** Globs of paths the mirror leaves alone on both sides, as `excludedBy` reads them. */
  exclude?: string[]
  /** The mirror's id, put for `<id>` in the hints. */
  id?: string
  /**
   * The owner confirmed that a root reported as replaced is the right folder now: its identity is recorded again and
   * the run is a first sync (identical files adopted, different ones conflicts), deleting nothing.
   */
  repin?: boolean
  /** How the app names the remote side; it ends a conflict copy's name. */
  remote: string
  /** How the app's commands are named in the guard's, the free space and the repin message. */
  hints?: Partial<MirrorHints>
  /** Runs one write behind the app's permission checks; `side` says which side it changes. */
  guard<T>(
    attempt: { action: MirrorAction; side: Side; path: string; operationId: string },
    act: () => Promise<T>,
  ): Promise<T>
  operationId(): string
  errorOf(error: unknown): CliError
  /** Throws once the sync lock is lost; checked before every write. */
  assertHeld(): void | Promise<void>
  signal?: AbortSignal
  /** Local files the mirror takes at most; more fail the run. */
  maxFiles?: number
  /** Bytes free for this process on the file system holding `path`, and its device. */
  space?(path: string): Promise<{ free: number; dev: number }>
  now?(): number
}

/** The app's commands, as the engine's messages name them; `<id>` is the mirror's id and `<count>` a number. */
export interface MirrorHints {
  /** How to preview a run: `ydisk work mirrors preview <id>`. */
  preview: string
  /** How to record a replaced root again: `ydisk work mirrors sync <id> --repin`. */
  repin: string
  /** The sync an approval is added to: `ydisk work mirrors sync <id>`. */
  sync: string
  /** How a sync allows deletions: `--allow-deletions <count>`. */
  allowDeletions: string
  /** How a sync allows replacements: `--allow-replacements <count>`. */
  allowReplacements: string
  /** How to exclude a folder: `ydisk work mirrors exclude <id> <glob>`. */
  exclude: string
}

const HINTS: MirrorHints = {
  preview: "--dry-run",
  repin: "--repin",
  sync: "sync",
  allowDeletions: "--allow-deletions <count>",
  allowReplacements: "--allow-replacements <count>",
  exclude: "--exclude <glob>",
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
  /** A whole-run refusal (the guard, too little space) is one error at path `.` with its `reason`. */
  errors: { path: string; code: string; message: string; reason?: string }[]
  /**
   * Files of the last sync missing from a side that cannot prove a deletion: its listing was incomplete, or its root
   * is gone or is another folder. Nothing is deleted for them.
   */
  unknown: { path: string; side: Side; reason: string }[]
  /** Every step but the unchanged files, on a dry run. */
  plan?: FileStep[]
  /** The deletions that stop the run without `allowDeletions`; a dry run reports them without stopping. */
  tooManyDeletions?: number
  /** The replacements of existing files that stop the run without `allowReplacements`. */
  tooManyReplacements?: number
  /** The run needs more free space than the file system at `path` has. */
  noSpace?: { path: string; needed: number; free: number }
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
 * A run that would delete more than `MAX_DELETIONS` files, or replace more than `MAX_REPLACEMENTS` existing files on
 * either side, stops before writing until the owner allows the count. Replacements get the higher bar: every content
 * one replaces is kept in the version store first, and bulk edits (a find-and-replace, a branch switch) are common.
 */
export const MAX_DELETIONS = 10
export const MAX_REPLACEMENTS = 50
/** What a run leaves free on a file system it downloads or keeps versions into. */
const SPARE_BYTES = 1024 ** 3
const MAX_FILES = 100_000
const CHECKS = 8
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

/** Every local file but excluded ones, hashed only when its size or mtime moved since the last sync. */
const scan = async (
  root: string,
  entries: Record<string, FileEntry>,
  excluded: (path: string) => boolean,
  maxFiles = MAX_FILES,
) => {
  const { files, links } = await scanLocal(
    root,
    () => "file",
    maxFiles,
    (path) => {
      const entry = entries[path]
      return entry && { size: entry.localSize, mtimeMs: entry.localMtimeMs, hash: entry.sha256 }
    },
    excluded,
  )
  return { files: files as Local[], links }
}

/** Remote files the mirror covers: hidden files and editor leftovers are skipped, as they are locally. */
const mirrored = (files: RemoteFile[]) => files.filter((file) => !file.path.split("/").some(skippedName))

/** False when `path` or a folder on the way to it is a symbolic link, so nothing under it is touched. */
const linkFree = (root: string, path: string) =>
  assertNoLink(root, path).then(
    () => true,
    (error: unknown) => {
      if (isCliError(error) && error.details?.reason === "mirror.symlink") return false
      throw error
    },
  )

/** True when the file at `absolute` is missing or has one of `hashes`: no partial copy is left there. */
const whole = async (absolute: string, hashes: (string | undefined)[]) => {
  try {
    return hashes.includes((await hashFile(absolute)).sha256)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
  }
}

/** True when `path` is `link` or lies under it. */
const under = (path: string, link: string) => path === link || path.startsWith(`${link}/`)

/** Free bytes and the device of the file system holding `path`, or of its nearest folder that exists. */
const freeSpace = async (path: string): Promise<{ free: number; dev: number }> => {
  for (let at = path; ; at = dirname(at)) {
    try {
      const [{ bavail, bsize }, { dev }] = await Promise.all([statfs(at), stat(at)])
      return { free: bavail * bsize, dev }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) throw error
    }
  }
}

const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

/**
 * Syncs a local folder and a remote folder of plain files both ways, whole files at a time. Each path is compared
 * three ways (local now, remote now, last sync): a change on one side is copied to the other, the same content on
 * both is adopted, and different changes on both are a conflict unless `keep` settles it. Deletions go to the
 * remote's trash and to `<root>/.wirecat-trash/`. A remote rename, found by the file's id, renames the local file.
 * Every write is conditional on what the listing saw, so a crash at any point is settled by the next run.
 */
export const syncFileMirror = async (options: FileMirrorOptions): Promise<FileMirrorResult> => {
  const { root, folder, target, principal, keep, signal, versions } = options
  const hints = { ...HINTS, ...options.hints }
  const fill = (hint: string, count?: number) =>
    hint.replaceAll("<id>", options.id ?? "<id>").replaceAll("<count>", count === undefined ? "<count>" : `${count}`)
  const excluded = excludedBy(options.exclude)
  const now = options.now ?? Date.now
  if (signal?.aborted) throw new CliError("cancelled", "sync was cancelled")
  if ((await target.identity()) !== principal)
    throw new CliError("authentication_error", "signed-in account does not match this profile", {
      reason: "profile.wrong-account",
    })
  const state = options.state.read()
  if (state.principal !== principal || state.root !== root || state.target !== folder)
    throw new CliError("configuration_error", "mirror state belongs to another account or mirror")
  const listed = await target.list(folder, signal, { excluded })
  const localRoot = await stat(root).catch(() => undefined)
  const remoteReplaced = listed !== undefined && state.rootId !== undefined && listed.rootId !== state.rootId
  const localReplaced =
    localRoot?.isDirectory() === true &&
    state.localRoot !== undefined &&
    (state.localRoot.dev !== localRoot.dev || state.localRoot.ino !== localRoot.ino)
  // Only a mirror whose root really was replaced is re-pinned; `repin` on a sync of every mirror leaves the others be.
  const repin = options.repin === true && (remoteReplaced || localReplaced)
  // An excluded path is absent by filter, never deleted: the last sync's entries under it are left out.
  const synced = Object.fromEntries(Object.entries(state.entries).filter(([path]) => !excluded(path)))
  // A re-pinned mirror starts over: the last sync's entries describe the folder it replaced.
  const entries = repin ? {} : synced
  const scanned = localRoot?.isDirectory()
    ? await scan(root, entries, excluded, options.maxFiles)
    : { files: [], links: [] }
  const local = new Map(scanned.files.map((file) => [file.path, file]))
  const problem = (side: Side, code: string, reason: string, repinnable = false) => ({ side, code, reason, repinnable })
  // A folder that is gone, replaced, or empty where the state had files (an unmounted drive) is not this mirror.
  const rootProblem = !listed
    ? problem("remote", "not_found", `the ${options.remote} folder is gone`)
    : remoteReplaced && !repin
      ? problem("remote", "confirmation_required", `the ${options.remote} folder was replaced by another one`, true)
      : !localRoot?.isDirectory()
        ? problem("local", "not_found", "the local folder is gone")
        : localReplaced && !repin
          ? problem("local", "confirmation_required", "the local folder was replaced by another one", true)
          : Object.keys(synced).length > 0 && !local.size
            ? problem(
                "local",
                "validation_error",
                "the local folder is empty; it may be an unmounted drive. Mount it, or if the files were really " +
                  "deleted, add a file to the folder or remove the mirror's state to start over",
              )
            : undefined
  const refused = rootProblem ? [] : (listed?.files ?? []).filter((file) => !safePath(file.path))
  const refusedIds = new Set(refused.map((file) => file.id))
  const visible = rootProblem ? [] : mirrored((listed?.files ?? []).filter((file) => safePath(file.path)))
  const remote = new Map(visible.filter((file) => !excluded(file.path)).map((file) => [file.path, file]))
  // Where a synced file went when it moved into an excluded folder on the remote.
  const excludedIds = new Set(visible.filter((file) => excluded(file.path)).map((file) => file.id))
  const sure = {
    local: rootProblem?.side !== "local",
    remote: rootProblem?.side !== "remote" && listed?.complete === true,
  }
  const base = { ...entries }

  const steps: Step[] = []
  const byId = new Map(visible.map((file) => [file.id, file]))
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
    result.unknown = Object.keys(synced).map((path) => ({ path, side, reason }))
    result.errors.push({
      path: ".",
      code,
      message: repinnable
        ? `${reason}; if it is the right folder now, sync again with ${fill(hints.repin)} to record it ` +
          "(that run deletes nothing)"
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
  const cutOff = new Set<string>()
  for (const path of paths) {
    // A synced file moved into an excluded folder is renamed there above, and then left alone.
    if (excluded(path)) continue
    const entry = base[path]
    if (entry && !local.has(path) && scanned.links.some((link) => under(path, link))) {
      steps.push({
        kind: "unknown",
        path,
        reason: "local",
        why: "under a symbolic link, which the sync does not follow",
      })
      continue
    }
    if (entry && !remote.has(path) && refusedIds.has(entry.id)) {
      steps.push({ kind: "unknown", path, reason: "remote", why: `moved on the ${options.remote} to a refused path` })
      continue
    }
    if (entry && !remote.has(path) && excludedIds.has(entry.id)) {
      steps.push({
        kind: "unknown",
        path,
        reason: "remote",
        why: `moved on the ${options.remote} into an excluded folder`,
      })
      continue
    }
    const file = remote.get(path)
    if (file && file.sha256 === undefined) {
      result.errors.push({ path, code: "provider_error", message: `the ${options.remote} has no hash for it yet` })
      continue
    }
    const here = local.get(path)
    // Where links fail, a download is copied into place; a crash midway leaves a partial file under the real name,
    // which must be neither sent nor overwritten.
    const pending = state.pending[path]
    // A replaced file is renamed into place whole; only a new file may be a partial copy.
    const created = pending?.op === "download" && pending.created !== false
    if (created && here && here.hash !== file?.sha256 && here.hash !== entry?.sha256) {
      cutOff.add(path)
      steps.push({
        kind: "conflict",
        path,
        local: here,
        ...(file ? { remote: file } : {}),
        reason: "an earlier download was cut off and the local file may be incomplete; move it away to download again",
      })
      continue
    }
    // A re-pinned run settles nothing: whatever `keep` says, different content is a conflict.
    const step = decide(path, sure, here, file, entry, repin ? undefined : keep)
    if (step) steps.push(step)
    else unchanged++
    // Saved without a write, so the next scan does not read a file only touched since the last sync.
    if (!step && entry && here && (entry.localMtimeMs !== here.mtimeMs || entry.localSize !== here.size))
      touched.push(path)
  }
  result.unchanged = unchanged
  const remotePath = (path: string) => posix.join(folder, path)
  // A listing read in pages can miss a file that moved while it was read, and a provider's flat listing may lag: a
  // file missing from it is deleted locally only once a direct read, made after the listing, finds nothing there.
  const absent = steps.filter((step) => step.kind === "trash-local")
  for (let at = 0; at < absent.length; at += CHECKS)
    await Promise.all(
      absent.slice(at, at + CHECKS).map(async (step) => {
        const why = await target.exists(remotePath(step.path), signal).then(
          (there) => (there ? `missing from the ${options.remote} listing, but still there` : undefined),
          (error: unknown) => {
            if (signal?.aborted) throw error
            return `the ${options.remote} could not say whether it was deleted: ${options.errorOf(error).message}`
          },
        )
        if (why) Object.assign(step, { kind: "unknown", reason: "remote", why })
      }),
    )
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
  const replacements = steps.filter(
    (step) =>
      (step.kind === "upload" && step.remote) || (step.kind === "download" && step.local) || step.kind === "keep-both",
  ).length
  const over = [
    ...(deletions > MAX_DELETIONS
      ? [
          {
            reason: "mirror.too-many-deletions",
            what: `delete ${deletions} files (more than ${MAX_DELETIONS})`,
            flag: fill(hints.allowDeletions, deletions),
            allowed: (options.allowDeletions ?? 0) >= deletions,
          },
        ]
      : []),
    ...(replacements > MAX_REPLACEMENTS
      ? [
          {
            reason: "mirror.too-many-replacements",
            what: `replace ${replacements} existing files (more than ${MAX_REPLACEMENTS})`,
            flag: fill(hints.allowReplacements, replacements),
            allowed: (options.allowReplacements ?? 0) >= replacements,
          },
        ]
      : []),
  ]
  if (deletions > MAX_DELETIONS) result.tooManyDeletions = deletions
  if (replacements > MAX_REPLACEMENTS) result.tooManyReplacements = replacements
  const noSpace = await shortOfSpace(steps, root, versions, options.space ?? freeSpace)
  if (noSpace) result.noSpace = noSpace
  if (options.dryRun) {
    result.plan = steps.map(({ kind, path, to }) => ({ kind, path, ...(to ? { to } : {}) }))
    return result
  }
  const unapproved = over.find((one) => !one.allowed)
  if (unapproved)
    result.errors.push({
      path: ".",
      code: "confirmation_required",
      reason: unapproved.reason,
      message:
        `this sync would ${over.map((one) => one.what).join(" and ")}; check them with \`${fill(hints.preview)}\`, ` +
        `then allow them with \`${fill(hints.sync)} ${over.map((one) => one.flag).join(" ")}\``,
    })
  if (noSpace)
    result.errors.push({
      path: ".",
      code: "validation_error",
      reason: "mirror.no-space",
      message:
        `this sync needs ${gigabytes(noSpace.needed)} on the drive of ${noSpace.path}, which has ` +
        `${gigabytes(noSpace.free)} free, and leaves ${gigabytes(SPARE_BYTES)} of it free; free some space, or ` +
        `leave big folders out with \`${fill(hints.exclude)}\``,
    })
  if (unapproved || noSpace) return result

  if (repin) {
    state.entries = {}
    state.rootId = listed?.rootId
    if (localRoot) state.localRoot = { dev: localRoot.dev, ino: localRoot.ino }
  } else {
    state.rootId ??= listed?.rootId
    if (localRoot) state.localRoot ??= { dev: localRoot.dev, ino: localRoot.ino }
  }
  for (const [path, pending] of Object.entries(state.pending)) {
    const parent = posix.dirname(path)
    if (pending.op === "download" && (parent === "." || (await linkFree(root, parent))))
      await rm(localTemp(join(root, path), tagOf(pending.operationId)), { force: true })
    if (!cutOff.has(path)) delete state.pending[path]
  }
  let savedAt = now()
  // A big mirror's state is megabytes of JSON: saved less often, it costs no more than a small one's.
  const saveEvery = SAVE_EVERY_MS * Math.max(1, Object.keys(state.entries).length / 10_000)
  const save = (force = false) => {
    if (!force && now() - savedAt < saveEvery) return
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
  const folders = new Set([...remote.keys()].map((path) => posix.dirname(path)))
  for (const path of [...folders]) for (let up = path; up !== "."; up = posix.dirname(up)) folders.add(up)
  let lastOperation = ""
  const write = async <T>(
    action: MirrorAction,
    side: Side,
    path: string,
    act: () => Promise<T>,
    operationId?: string,
  ) => {
    await options.assertHeld()
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

  /**
   * Keeps the remote content an upload will replace, downloaded through the store unless it holds it already.
   * Refused as `mirror.remote-changed` when the remote no longer has the listed content.
   */
  const keepRemote = async (path: string, file: RemoteFile) => {
    const listed = file.sha256 as string
    if (versions.has(listed)) return
    const kept = await versions.keep((temp) => target.download(remotePath(path), temp, signal))
    if (kept !== listed)
      throw new CliError("conflict", `the ${options.remote} file changed since the listing`, {
        reason: "mirror.remote-changed",
      })
  }
  const upload = async (path: string, from: Local, expect: Expect, created: boolean, replaced?: RemoteFile) => {
    if (replaced) await keepRemote(path, replaced)
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
      ...("sha256" in expect ? { old: expect.sha256, from: "remote" as const } : {}),
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
    state.pending[path] = { op: "download", operationId, created: !over }
    save(true)
    const absolute = join(root, path)
    let written: { sha256: string } | undefined
    let old: string | undefined
    try {
      await assertNoLink(root, path)
      await mkdir(dirname(absolute), { recursive: true })
      old = over ? await versions.keep(absolute) : undefined
      written = await write(
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
    } catch (error) {
      // A failed copy into place removes what it wrote; should that removal fail too, the marker keeps the partial
      // file from being sent or overwritten.
      if (await whole(absolute, [file.sha256, over?.hash])) delete state.pending[path]
      throw error
    }
    delete state.pending[path]
    if (!written) return false
    if (recorded) record(path, file, await stat(absolute), written.sha256)
    versions.log({
      path,
      event: old ? "changed" : "created",
      direction: "remote-to-local",
      ...(old ? { old, from: "local" as const } : {}),
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
        if (here) await upload(path, here, expectOf(there), !there, there)
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
          from: "remote",
          // Not downloaded to be kept: the provider's trash holds it, and a deleted folder may be large.
          ...(versions.has(there.sha256 as string) ? {} : { oldIn: "remote-trash" as const }),
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
        versions.log({ path, event: "deleted", direction: "remote-to-local", old, from: "local", size: here.size })
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
        if ((await versions.keep(join(root, copy))) !== there.sha256) await keepRemote(path, there)
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
        // A download's outcome is known: its temporary file is gone and the file is in place or not.
        if (failure.code === "outcome_unknown" && step.kind !== "download")
          state.pending[step.path] = { op: step.kind, operationId: lastOperation }
      }
    }
  } finally {
    // Forgotten, so a file whose exclusion is removed later is a new file, never a deletion.
    for (const path of Object.keys(state.entries)) if (excluded(path)) delete state.entries[path]
    save(true)
  }
  await options.assertHeld()
  await versions.prune()
  return result
}

/**
 * The free space a run needs that a file system lacks: downloads land under `root`, and the store keeps every
 * content they replace or a deletion removes, plus each remote content an upload replaces that it lacks.
 */
const shortOfSpace = async (
  steps: Step[],
  root: string,
  versions: FileVersions,
  space: (path: string) => Promise<{ free: number; dev: number }>,
) => {
  let incoming = 0
  let kept = 0
  for (const step of steps) {
    const local = step.local?.size ?? 0
    const remote = step.remote?.size ?? 0
    if (step.kind === "download") {
      incoming += remote
      kept += local
    }
    if (step.kind === "keep-both") {
      incoming += remote
      kept += remote
    }
    if (step.kind === "trash-local") kept += local
    if (step.kind === "upload" && step.remote && !versions.has(step.remote.sha256 as string)) kept += remote
  }
  if (!incoming && !kept) return undefined
  const here = await space(root)
  const store = versions.dir === undefined ? here : await space(versions.dir)
  const needs =
    store.dev === here.dev
      ? [{ path: root, needed: incoming + kept, free: here.free }]
      : [
          { path: root, needed: incoming, free: here.free },
          { path: versions.dir as string, needed: kept, free: store.free },
        ]
  return needs.find((need) => need.needed > 0 && need.free < need.needed + SPARE_BYTES)
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
  pending: v.record(
    v.string(),
    v.object({ op: v.string(), operationId: v.string(), created: v.optional(v.boolean()) }),
  ),
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
    const excluded = excludedBy(mirror.exclude)
    const entries = Object.fromEntries(
      Object.entries(stateOf(mirror).read().entries).filter(([path]) => !excluded(path)),
    )
    const { files, links } = await scan(mirror.path, entries, excluded)
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
    | "allowReplacements"
    | "repin"
    | "hints"
    | "guard"
    | "operationId"
    | "errorOf"
    | "signal"
    | "space"
  > {
  mirrors: Mirror[]
  stateOf(mirror: Mirror): FileMirrorStatePort
  versionsOf(mirror: Mirror): FileVersions
  /** The sync lock, as `acquireLock` returns it or with a synchronous `assertHeld`. */
  lock(): Promise<HeldLock>
  /** How the app names the remote side in reports and conflict copies. */
  remote: string
}

/** Syncs each file mirror under one lock, with one `mirror.partial` issue per mirror left with conflicts or errors. */
export const syncFileMirrors = (options: FileMirrorSyncOptions) =>
  eachMirror(options.mirrors, options.lock, options.remote, (mirror, held) =>
    syncFileMirror({
      ...options,
      root: mirror.path,
      folder: mirror.folder,
      id: mirror.id,
      ...(mirror.exclude ? { exclude: mirror.exclude } : {}),
      state: options.stateOf(mirror),
      versions: options.versionsOf(mirror),
      assertHeld: heldCheck(held),
    }),
  )
