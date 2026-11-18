import { createHash, randomUUID } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import { chmod, copyFile, link, lstat, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, posix } from "node:path"
import { CliError, isCliError } from "@wirecat/cli-base"
import type {
  ConflictPart,
  DocumentTarget,
  Keep,
  LocalDocument,
  Pushed,
  PushPlan,
  PushState,
  PushStatePort,
} from "../../documents/push-model.js"

export interface PushOptions<S> {
  /** Absolute path of the local folder being mirrored. */
  root: string
  /** Remote folder id the mirror writes into. */
  folder: string
  target: DocumentTarget<S>
  state: PushStatePort<S>
  principal: string
  /** Settles stretches both sides changed; without it they are conflicts. */
  keep?: Keep
  /** Creates again a remote file that was deleted. */
  recreate?: boolean
  dryRun?: boolean
  /** Runs one remote write behind the provider's permission checks and write journal. */
  guard<T>(attempt: { action: MirrorAction; path: string; operationId: string }, act: () => Promise<T>): Promise<T>
  operationId(): string
  errorOf(error: unknown): CliError
  assertHeld(): void
  signal?: AbortSignal
  maxFiles?: number
  now?(): number
}
/** What a mirror's write does; the guard maps it to the app's permission keys. */
export type MirrorAction = "create" | "update" | "folder" | "delete" | "move"
export interface PushConflict {
  path: string
  /** The remote file's address, when the provider has one. */
  url?: string
  reason: string
  parts?: ConflictPart[]
  localChangedAt?: string
  remoteChangedAt?: string
  remoteChangedBy?: string
  localSize?: number
  remoteSize?: number
}
export interface PushResult {
  created: string[]
  updated: string[]
  /** Local files rewritten with changes made on the remote. */
  pulled: string[]
  unchanged: number
  conflicts: PushConflict[]
  missing: string[]
  orphans: { path: string; url: string }[]
  errors: { path: string; code: string; message: string }[]
  unsupported: number
  plan?: { create: string[]; update: string[]; orphans: string[] }
  stopped?: true
}

const SKIPPED = /^(\.|node_modules$|~\$)|(~|\.swp|\.tmp)$/

/** Hidden files, `node_modules` and editor leftovers: never mirrored, and never a reason to sync. */
export const skippedName = (name: string): boolean => SKIPPED.test(name)

/** The sha256 and md5 of a file, read as a stream: a file of any size takes the same memory. */
export const hashFile = (path: string): Promise<{ sha256: string; md5: string }> =>
  new Promise((done, fail) => {
    const sha256 = createHash("sha256")
    const md5 = createHash("md5")
    createReadStream(path)
      .on("data", (chunk) => {
        sha256.update(chunk)
        md5.update(chunk)
      })
      .on("error", fail)
      .on("end", () => done({ sha256: sha256.digest("hex"), md5: md5.digest("hex") }))
  })

/**
 * Puts `from` at `to` only while `to` is absent: a hard link, or a copy made with `COPYFILE_EXCL` where the file
 * system has no hard links (exFAT, FAT, many FUSE and SMB mounts) or `to` is on another device. Fails with `EEXIST`
 * when `to` exists; `from` stays for the caller to remove.
 */
export const placeNew = async (from: string, to: string) => {
  try {
    await link(from, to)
    return
  } catch (error) {
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw error
  }
  try {
    await copyFile(from, to, constants.COPYFILE_EXCL)
  } catch (error) {
    // Only an exclusive create that succeeded can have left a partial copy behind.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") await rm(to, { force: true })
    throw error
  }
}

/** A relative path whose every segment names one entry: none empty, `.` or `..`, none with a backslash or NUL. */
export const safePath = (path: string): boolean =>
  path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !/[\\\0]/.test(part))

/**
 * Refuses a write at `path` under `root` when a folder on the way, or the file itself, is a symbolic link: a write
 * would follow it out of the mirrored folder. A part that does not exist yet ends the check.
 */
export const assertNoLink = async (root: string, path: string) => {
  let at = root
  for (const part of path.split("/")) {
    at = join(at, part)
    try {
      if ((await lstat(at)).isSymbolicLink())
        throw new CliError("validation_error", `${path} is under a symbolic link; the sync does not follow links`, {
          reason: "mirror.symlink",
        })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }
}

/** A hidden temporary file beside `absolute`; `tag` lets a caller find a crash's leftover again. */
export const localTemp = (absolute: string, tag: string) => join(dirname(absolute), `.${basename(absolute)}.${tag}.tmp`)

/**
 * Writes `absolute` through a temporary file beside it. With `hash`, the file is replaced only while it still has
 * that sha256 (someone may have saved it during the sync) and keeps its mode; without, it is created only while
 * absent. `content` is text, bytes, or a writer that fills the temporary file, for a stream of any size; with
 * `sha256`, content with another hash is refused before it takes the file's place. `tag` names the temporary file, so
 * a crash's leftover can be found. Returns the new file's hashes, or undefined, with nothing written, when the file
 * was not as `hash` said.
 */
export const replaceLocal = async (
  absolute: string,
  hash: string | undefined,
  content: string | Uint8Array | ((temp: string) => Promise<void>),
  { tag = randomUUID().slice(0, 8), sha256 }: { tag?: string; sha256?: string } = {},
): Promise<{ sha256: string; md5: string } | undefined> => {
  const temp = localTemp(absolute, tag)
  const mode = hash === undefined ? undefined : (await stat(absolute)).mode
  try {
    if (typeof content === "function") await content(temp)
    else await writeFile(temp, content, { flag: "wx" })
    // A mode passed to the write goes through the umask; set it after, so a group-writable file stays one.
    if (mode !== undefined) await chmod(temp, mode & 0o777)
    const written = await hashFile(temp)
    if (sha256 !== undefined && written.sha256 !== sha256)
      throw new CliError("invalid_response", "the downloaded file has other content than the listing said", {
        reason: "download.mismatch",
      })
    if (hash === undefined) {
      // A link fails when the name exists, where a rename would replace a file created during the sync.
      try {
        await placeNew(temp, absolute)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined
        throw error
      }
      return written
    }
    if ((await hashFile(absolute)).sha256 !== hash) return undefined
    await rename(temp, absolute)
    return written
  } finally {
    await rm(temp, { force: true })
  }
}

/**
 * Files under `root` the target pushes. Hidden files, editor leftovers and symbolic links are never followed; the
 * links' paths are returned in `links`, so a mirror does not take the files behind one as deleted. A file whose size
 * and mtime match what `known` returns keeps that hash instead of being read again.
 */
export const scanLocal = async (
  root: string,
  kindOf: (path: string) => string | undefined,
  maxFiles = 10_000,
  known?: (path: string) => { size: number; mtimeMs: number; hash: string } | undefined,
): Promise<{ files: LocalDocument[]; unsupported: number; links: string[] }> => {
  const files: LocalDocument[] = []
  const links: string[] = []
  let unsupported = 0
  const walk = async (relative: string) => {
    const entries = await readdir(join(root, relative), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED.test(entry.name)) continue
      const path = relative ? posix.join(relative, entry.name) : entry.name
      if (entry.isSymbolicLink()) {
        links.push(path)
        continue
      }
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const kind = kindOf(path)
        if (!kind) {
          unsupported++
          continue
        }
        if (files.length >= maxFiles)
          throw new CliError("validation_error", `the folder holds more than ${maxFiles} files to push`, {
            reason: "push.too-many-files",
          })
        const absolute = join(root, path)
        const { size, mtimeMs } = await stat(absolute)
        const before = known?.(path)
        const hash =
          before && before.size === size && before.mtimeMs === mtimeMs ? before.hash : (await hashFile(absolute)).sha256
        files.push({ path, absolute, kind, hash, size, mtimeMs })
      }
    }
  }
  try {
    await walk("")
  } catch (error) {
    if (isCliError(error)) throw error
    throw new CliError("validation_error", "the folder to push could not be read", { reason: "push.unreadable" })
  }
  return { files, unsupported, links }
}

/** What a push would do, from the local files and the last push alone: no remote read. */
export const planPush = <S>(files: LocalDocument[], state: PushState<S>): PushPlan => {
  const plan: PushPlan = { create: [], update: [], unchanged: [], orphans: [] }
  const seen = new Set<string>()
  for (const file of files) {
    seen.add(file.path)
    const entry = state.entries[file.path]
    if (!entry) plan.create.push(file)
    else if (entry.hash !== file.hash) plan.update.push(file)
    else plan.unchanged.push(file)
  }
  plan.orphans = Object.keys(state.entries).filter((path) => !seen.has(path))
  return plan
}

const originOf = (principal: string, root: string, folder: string, path: string) =>
  createHash("sha256")
    .update(JSON.stringify([principal, root, folder, path]))
    .digest("hex")
    .slice(0, 32)

export const pushDocuments = async <S>(options: PushOptions<S>): Promise<PushResult> => {
  const { root, folder, target, principal, keep, recreate = false, signal } = options
  const now = options.now ?? Date.now
  if (signal?.aborted) throw new CliError("cancelled", "push was cancelled")
  if ((await target.identity()) !== principal)
    throw new CliError("authentication_error", "signed-in account does not match this profile", {
      reason: "profile.wrong-account",
    })
  const state = options.state.read()
  if (state.principal !== principal || state.root !== root || state.target !== folder)
    throw new CliError("configuration_error", "push state belongs to another account or mirror")
  const save = () => options.state.save(state)
  if (!options.dryRun)
    for (const [path, pending] of Object.entries(state.pending)) {
      const found = await target.findByOrigin(pending.origin)
      // An empty hash makes this pass update the found file from the local one.
      if (found) state.entries[path] = { ...found, kind: target.kindOf(path) ?? "", hash: "", pushedAt: "" }
      delete state.pending[path]
      save()
    }
  const { files, unsupported } = await scanLocal(root, (path) => target.kindOf(path), options.maxFiles)
  const plan = planPush(files, state)
  const result: PushResult = {
    created: [],
    updated: [],
    pulled: [],
    unchanged: 0,
    conflicts: [],
    missing: [],
    orphans: plan.orphans.map((path) => ({ path, url: state.entries[path]?.url ?? "" })),
    errors: [],
    unsupported,
  }
  if (options.dryRun) {
    result.plan = {
      create: plan.create.map((file) => file.path),
      update: plan.update.map((file) => file.path),
      orphans: plan.orphans,
    }
    return result
  }

  const folderOf = async (path: string): Promise<string> => {
    const directory = posix.dirname(path)
    if (directory === ".") return folder
    const known = state.folders[directory]
    if (known) return known
    const parent = await folderOf(directory)
    const operationId = options.operationId()
    options.assertHeld()
    const id = await options.guard({ action: "folder", path: directory, operationId }, () =>
      target.ensureFolder({
        parent,
        name: posix.basename(directory),
        origin: originOf(principal, root, folder, `${directory}/`),
      }),
    )
    state.folders[directory] = id
    save()
    return id
  }
  const create = async (file: LocalDocument) => {
    const parent = await folderOf(file.path)
    const operationId = options.operationId()
    const origin = originOf(principal, root, folder, file.path)
    state.pending[file.path] = { origin, operationId }
    save()
    options.assertHeld()
    const pushed = await options.guard({ action: "create", path: file.path, operationId }, () =>
      target.create({
        file,
        name: posix.basename(file.path),
        parent,
        origin,
        operationId,
        ...(signal ? { signal } : {}),
      }),
    )
    state.entries[file.path] = { ...pushed, kind: file.kind, hash: file.hash, pushedAt: new Date(now()).toISOString() }
    delete state.pending[file.path]
    save()
    result.created.push(file.path)
  }

  // A file unchanged here may have changed remotely, so every mirrored file is read back.
  const work = [
    ...plan.create.map((file) => ({ file, create: true })),
    ...plan.update.map((file) => ({ file, create: false })),
    ...plan.unchanged.map((file) => ({ file, create: false })),
  ]
  for (const job of work.sort((a, b) => a.file.path.localeCompare(b.file.path))) {
    if (signal?.aborted) {
      result.stopped = true
      break
    }
    const { file } = job
    try {
      const entry = state.entries[file.path]
      if (job.create || !entry) {
        await create(file)
        continue
      }
      const prepared = await target.prepare({
        id: entry.id,
        file,
        recorded: entry.snapshot,
        ...(keep ? { keep } : {}),
        ...(signal ? { signal } : {}),
      })
      if ("conflict" in prepared) {
        const { mtime } = await stat(file.absolute)
        result.conflicts.push({
          path: file.path,
          url: entry.url,
          reason: prepared.conflict,
          ...(prepared.parts ? { parts: prepared.parts } : {}),
          localChangedAt: mtime.toISOString(),
          ...(prepared.remote?.changedAt ? { remoteChangedAt: prepared.remote.changedAt } : {}),
          ...(prepared.remote?.changedBy ? { remoteChangedBy: prepared.remote.changedBy } : {}),
        })
        continue
      }
      if ("missing" in prepared) {
        if (!recreate) {
          result.missing.push(file.path)
          continue
        }
        delete state.entries[file.path]
        await create(file)
        continue
      }
      let pushed: Pushed<S>
      let hash = file.hash
      if ("unchanged" in prepared) {
        pushed = prepared.unchanged
        result.unchanged++
      } else {
        // The local file goes first: if the remote write then fails, the next sync finds the same change on
        // both sides and merges it once.
        if (prepared.local !== undefined) {
          options.assertHeld()
          await assertNoLink(root, file.path)
          const written = await replaceLocal(file.absolute, file.hash, prepared.local)
          if (!written) {
            result.conflicts.push({ path: file.path, url: entry.url, reason: "the local file changed during the sync" })
            continue
          }
          hash = written.sha256
          result.pulled.push(file.path)
          if (prepared.remote && prepared.afterLocal !== undefined) {
            state.entries[file.path] = { ...entry, snapshot: prepared.afterLocal, hash }
            save()
          }
        }
        if (prepared.remote) {
          const operationId = options.operationId()
          options.assertHeld()
          pushed = await options.guard({ action: "update", path: file.path, operationId }, () => prepared.write())
          result.updated.push(file.path)
        } else pushed = await prepared.write()
      }
      state.entries[file.path] = {
        ...pushed,
        kind: file.kind,
        hash,
        pushedAt: new Date(now()).toISOString(),
      }
      save()
    } catch (error) {
      const failure = options.errorOf(error)
      if (failure.code === "cancelled") {
        result.stopped = true
        break
      }
      result.errors.push({ path: file.path, code: failure.code, message: failure.message })
    }
  }
  return result
}
