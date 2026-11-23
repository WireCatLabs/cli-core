import { createHash } from "node:crypto"
import { mkdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, posix } from "node:path"
import { CliError } from "@wirecat/cli-base"
import type {
  Expect,
  FileConflict,
  FileEntry,
  FileMirrorStatePort,
  FileStepKind,
  FileTarget,
  RemoteFile,
} from "../../documents/file-mirror-model.js"
import type { ConflictPart, Keep } from "../../documents/push-model.js"
import { eachMirror, type HeldLock, heldCheck, type Mirror } from "../documents/mirrors.js"
import {
  assertNoLink,
  localTemp,
  type MirrorAction,
  type PushConflict,
  replaceLocal,
  safePath,
  skippedName,
} from "../documents/push.js"
import { excludedBy } from "./exclusions.js"
import { listRemote } from "./listing.js"
import {
  ancestors,
  copyName,
  freeSpace,
  gigabytes,
  type Local,
  linkFree,
  MAX_FILES,
  renameLocal,
  scan,
  shortOfSpace,
  spareFor,
  trashLocal,
  under,
  whole,
} from "./local-files.js"
import { mergeable, mergeText } from "./text-merge.js"
import type { FileVersions, VersionParts } from "./versions.js"

export { fileMirrorStatus, fileSyncState } from "./mirror-state.js"

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
  /**
   * Lets a run replace this many existing files, on either side, although the guard would stop it. An app with a
   * `--replace` switch passes `Number.POSITIVE_INFINITY`.
   */
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
  /** Files the mirror takes at most: more local ones fail the run, more remote ones leave the listing incomplete. */
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
  /** How to leave a folder out: `ydisk work mirrors update <id> --ignore <path>`. */
  exclude: string
}

const HINTS: MirrorHints = {
  preview: "--dry-run",
  repin: "--repin",
  sync: "sync",
  allowDeletions: "--allow-deletions <count>",
  allowReplacements: "--allow-replacements <count>",
  exclude: "--ignore <path>",
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
  /** Text files both sides changed, merged and written to both. */
  merged: string[]
  /** Local files given the remote's own form of what was just uploaded, for a target that `rewrites`. */
  rewritten?: string[]
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
/** The whole-file step `keep` settles a conflict with when both sides changed. */
const KEPT: Record<Keep, FileStepKind> = { local: "upload", remote: "download", both: "keep-both" }
const CHECKS = 8
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
  merges = false,
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
  if (merges) return step("merge")
  return settle("changed on both sides", "upload", "download", "keep-both")

  function settle(reason: string, ...[ifLocal, ifRemote, ifBoth]: [FileStepKind, FileStepKind, FileStepKind]) {
    if (keep === "local") return step(ifLocal)
    if (keep === "remote") return step(ifRemote)
    if (keep === "both") return step(ifBoth)
    return step("conflict", reason)
  }
}

/** Remote files the mirror covers: hidden files and editor leftovers are skipped, as they are locally. */
const mirrored = (files: RemoteFile[]) => files.filter((file) => !file.path.split("/").some(skippedName))

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
  const { listed, progress } = await listRemote(
    target,
    folder,
    signal,
    excluded,
    state.listing,
    now(),
    options.maxFiles ?? MAX_FILES,
  )
  // Kept before any refusal below, so a stopped run's pages are not listed again. A completed listing's progress is
  // cleared only once the run gets past its refusals: a run stopped by the guard goes on from there.
  if (!options.dryRun && listed?.complete !== true && (progress || state.listing)) {
    if (progress) state.listing = progress
    else delete state.listing
    options.state.save(state)
  }
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
    merged: [],
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
    // Asked only of a file both sides changed: the store is not read for every unchanged one.
    const merges =
      here !== undefined &&
      file !== undefined &&
      entry !== undefined &&
      here.hash !== entry.sha256 &&
      file.sha256 !== entry.sha256 &&
      mergeable(path, here.size, file.size, entry.size) &&
      versions.has(entry.sha256)
    const step = decide(path, sure, here, file, entry, repin ? undefined : keep, merges)
    // The same three contents the last run could not merge are not downloaded and merged again at every watch cycle.
    const known = state.conflicts?.[path]
    if (
      step?.kind === "merge" &&
      known?.kept &&
      known.base === entry?.sha256 &&
      known.local === here?.hash &&
      known.remote === file?.sha256
    )
      Object.assign(step, keep ? { kind: KEPT[keep] } : { kind: "conflict", reason: known.reason })
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
        const why = await target.exists(remotePath(step.path), signal, step.base?.id).then(
          (there) => (there ? `missing from the ${options.remote} listing, but still there` : undefined),
          (error: unknown) => {
            if (signal?.aborted) throw error
            return `the ${options.remote} could not say whether it was deleted: ${options.errorOf(error).message}`
          },
        )
        if (why) Object.assign(step, { kind: "unknown", reason: "remote", why })
      }),
    )
  const earlier = state.conflicts ?? {}
  const conflicts: Record<string, FileConflict> = {}
  /** Reports and records a conflict; `kept` are the contents a failed merge kept, logged once per set of them. */
  const conflict = (step: Step, reason: string, kept?: { parts: VersionParts; segments?: ConflictPart[] }) => {
    result.conflicts.push({
      path: step.path,
      reason,
      ...(kept?.segments ? { parts: kept.segments } : {}),
      ...(step.local ? { localChangedAt: new Date(step.local.mtimeMs).toISOString(), localSize: step.local.size } : {}),
      ...(step.remote ? { remoteChangedAt: step.remote.modifiedAt, remoteSize: step.remote.size } : {}),
    })
    const found: FileConflict = {
      reason,
      at: new Date(now()).toISOString(),
      ...(step.base ? { base: step.base.sha256 } : {}),
      ...(step.local ? { local: step.local.hash } : {}),
      ...(step.remote ? { remote: step.remote.sha256 as string, remoteFile: step.remote } : {}),
    }
    const before = earlier[step.path]
    const same = before?.base === found.base && before?.local === found.local && before?.remote === found.remote
    if (kept) {
      found.kept = true
      // A conflict `keep` settles at once is no conflict anyone resolves later.
      if (!keep && (!same || !before?.kept))
        versions.log({ path: step.path, event: "conflict", direction: "both", parts: kept.parts })
    } else if (same && before?.kept) found.kept = true
    // A conflict seen again keeps the time it was first found.
    conflicts[step.path] = same && before ? { ...found, at: before.at } : found
  }
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
      (step.kind === "upload" && step.remote) ||
      (step.kind === "download" && step.local) ||
      step.kind === "keep-both" ||
      step.kind === "merge",
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
        `${gigabytes(noSpace.free)} free, and leaves ${gigabytes(spareFor(noSpace.needed))} of it free; free some space, or ` +
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
  if (listed?.complete) delete state.listing
  let savedAt = now()
  // A big mirror's state is megabytes of JSON: saved less often, it costs no more than a small one's.
  const saved = Object.keys(state.entries).length + (state.listing?.files.length ?? 0)
  const saveEvery = SAVE_EVERY_MS * Math.max(1, saved / 10_000)
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
  /** Keeps a mergeable file's synced content, the base of its next merge; a file that changed meanwhile has none. */
  const keepBase = async (path: string, absolute: string, sha256: string, size: number) => {
    // A base that could not be kept costs a conflict at the next change on both sides, never this run's write.
    if (mergeable(path, size) && !versions.has(sha256)) await versions.keep(absolute).catch(() => undefined)
  }
  const upload = async (
    path: string,
    from: Local,
    expect: Expect,
    created: boolean,
    replaced?: RemoteFile,
    merged = false,
  ) => {
    if (replaced) await keepRemote(path, replaced)
    for (const up of ancestors(path))
      if (!folders.has(up)) {
        await write("folder", "remote", up, () => target.ensureFolder(remotePath(up), signal))
        folders.add(up)
      }
    const sent = await write(created ? "create" : "update", "remote", path, () =>
      target.upload(remotePath(path), from.absolute, expect, signal),
    )
    const rewritten = sent.sha256 !== undefined && sent.sha256 !== from.hash
    if (rewritten && !target.rewrites)
      throw new CliError("conflict", "the local file changed during the upload", { reason: "upload.mismatch" })
    if (!merged) {
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
    if (rewritten) return takeRewrite(path, sent, from)
    record(path, sent, from, from.hash)
    await keepBase(path, from.absolute, from.hash, from.size)
  }
  /**
   * Puts the remote's own form of an upload into the local file, so both sides hold the same bytes and the next
   * merge has one base. The local file keeps its version first; one saved meanwhile stays, sent by the next sync.
   */
  const takeRewrite = async (path: string, sent: RemoteFile, from: Local) => {
    const form = sent.sha256 as string
    const kept = await versions.keep((temp) => target.download(remotePath(path), temp, signal))
    if (kept !== form)
      throw new CliError("conflict", `the ${options.remote} file changed right after the upload`, {
        reason: "mirror.remote-changed",
      })
    const absolute = join(root, path)
    await assertNoLink(root, path)
    const old = await versions.keep(absolute)
    const placed =
      old === from.hash && (await write("update", "local", path, () => versions.write(form, absolute, from.hash)))
    if (!placed) {
      // A local size no file has: the file is hashed again and sent, never taken for the remote's form.
      record(path, sent, { size: -1, mtimeMs: -1 }, form)
      return
    }
    record(path, sent, await stat(absolute), form)
    versions.log({
      path,
      event: "changed",
      direction: "remote-to-local",
      old,
      from: "local",
      new: form,
      size: sent.size,
    })
    result.rewritten = [...(result.rewritten ?? []), path]
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
    if (recorded) {
      record(path, file, await stat(absolute), written.sha256)
      await keepBase(path, absolute, written.sha256, file.size)
    }
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

  /**
   * Merges a text file both sides changed: the remote and the local contents are kept first, the merge reads all
   * three from the store, and the result is written locally, then uploaded over the remote the listing saw. False
   * when the lines conflict, so `keep` can settle the file whole.
   */
  const merge = async (step: Step, here: Local, there: RemoteFile, last: FileEntry) => {
    const { path } = step
    const remoteHash = there.sha256 as string
    await keepRemote(path, there)
    if ((await versions.keep(here.absolute)) !== here.hash) {
      changedHere(step)
      return true
    }
    const parts = { base: last.sha256, local: here.hash, remote: remoteHash }
    const [base, mine, theirs] = await Promise.all(
      [last.sha256, here.hash, remoteHash].map((hash) => versions.read(hash)),
    )
    if (!base || !mine || !theirs) {
      conflict(step, "changed on both sides, and the earlier version to merge against is no longer kept")
      return false
    }
    const merged = await mergeText(path, base, mine, theirs)
    if (!("merged" in merged)) {
      conflict(step, "changed on both sides in the same lines", {
        parts,
        segments: merged.conflicts.map(({ base, local, remote }) => ({ base, local, remote })),
      })
      return false
    }
    const outcome = await versions.keep((temp) => writeFile(temp, merged.merged, { flag: "wx", mode: 0o600 }))
    const absolute = join(root, path)
    await assertNoLink(root, path)
    const operationId = options.operationId()
    const written = await write(
      "update",
      "local",
      path,
      () => replaceLocal(absolute, here.hash, merged.merged, { tag: tagOf(operationId), sha256: outcome }),
      operationId,
    )
    if (!written) {
      changedHere(step)
      return true
    }
    const placed = await stat(absolute)
    // Both sides as the remote is now, with a local size no file has: a crash before the upload leaves the merged
    // file a local change, hashed again and sent by the next run, never merged twice.
    state.entries[path] = {
      id: there.id,
      size: there.size,
      sha256: remoteHash,
      ...(there.md5 ? { md5: there.md5 } : {}),
      remoteModified: there.modifiedAt,
      localMtimeMs: -1,
      localSize: -1,
      syncedAt: new Date(now()).toISOString(),
    }
    save(true)
    versions.log({ path, event: "merged", direction: "both", parts, new: outcome, size: placed.size })
    const sent = { ...here, hash: outcome, size: placed.size, mtimeMs: placed.mtimeMs }
    await upload(path, sent, expectOf(there), false, undefined, true)
    result.merged.push(path)
    return true
  }
  const run = async (step: Step) => {
    const { path, local: here, remote: there, base: last } = step
    switch (step.kind) {
      case "conflict":
        return
      case "adopt":
        if (here && there) {
          record(path, there, here, here.hash)
          await keepBase(path, here.absolute, here.hash, here.size)
        }
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
      case "merge":
        if (!here || !there || !last) return
        if (!(await merge(step, here, there, last)) && keep) {
          result.conflicts.pop()
          delete conflicts[path]
          return run({ ...step, kind: KEPT[keep] })
        }
        return
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
    // A mirror synced before merges existed has no bases: an unchanged text file's content becomes its base now.
    const stepped = new Set(steps.map((step) => step.path))
    for (const [path, entry] of Object.entries(state.entries)) {
      if (signal?.aborted) break
      const here = local.get(path)
      if (here?.hash === entry.sha256 && !stepped.has(path))
        await keepBase(path, here.absolute, entry.sha256, here.size)
    }
  } finally {
    // Forgotten, so a file whose exclusion is removed later is a new file, never a deletion.
    for (const path of Object.keys(state.entries)) if (excluded(path)) delete state.entries[path]
    if (Object.keys(conflicts).length) state.conflicts = conflicts
    else delete state.conflicts
    save(true)
  }
  await options.assertHeld()
  await versions.prune(
    Object.entries(state.entries)
      .filter(([path, entry]) => mergeable(path, entry.size))
      .map(([, entry]) => entry.sha256),
  )
  return result
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
