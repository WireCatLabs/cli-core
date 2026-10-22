import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { readdir, rename, rm, stat, writeFile } from "node:fs/promises"
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
  guard<T>(
    attempt: { action: "create" | "update" | "folder"; path: string; operationId: string },
    act: () => Promise<T>,
  ): Promise<T>
  operationId(): string
  errorOf(error: unknown): CliError
  assertHeld(): void
  signal?: AbortSignal
  maxFiles?: number
  now?(): number
}
export interface PushConflict {
  path: string
  url: string
  reason: string
  parts?: ConflictPart[]
  localChangedAt?: string
  remoteChangedAt?: string
  remoteChangedBy?: string
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

const hashFile = (path: string): Promise<string> =>
  new Promise((done, fail) => {
    const hash = createHash("sha256")
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", fail)
      .on("end", () => done(hash.digest("hex")))
  })

const hashText = (text: string) => createHash("sha256").update(text).digest("hex")

/**
 * Replaces the file through a temporary file beside it, keeping its mode. Undefined, and nothing written, when
 * the file no longer has `hash`: someone saved it during the sync.
 */
const replaceLocal = async (file: LocalDocument, content: string): Promise<string | undefined> => {
  const temp = join(dirname(file.absolute), `.${basename(file.absolute)}.${randomUUID().slice(0, 8)}.tmp`)
  const { mode } = await stat(file.absolute)
  await writeFile(temp, content, { mode: mode & 0o777, flag: "wx" })
  try {
    if ((await hashFile(file.absolute)) !== file.hash) return undefined
    await rename(temp, file.absolute)
  } finally {
    await rm(temp, { force: true })
  }
  return hashText(content)
}

/** Files under `root` the target pushes. Hidden files, editor leftovers and symbolic links are never followed. */
export const scanLocal = async (
  root: string,
  kindOf: (path: string) => string | undefined,
  maxFiles = 10_000,
): Promise<{ files: LocalDocument[]; unsupported: number }> => {
  const files: LocalDocument[] = []
  let unsupported = 0
  const walk = async (relative: string) => {
    const entries = await readdir(join(root, relative), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED.test(entry.name) || entry.isSymbolicLink()) continue
      const path = relative ? posix.join(relative, entry.name) : entry.name
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
        files.push({ path, absolute, kind, hash: await hashFile(absolute) })
      }
    }
  }
  try {
    await walk("")
  } catch (error) {
    if (isCliError(error)) throw error
    throw new CliError("validation_error", "the folder to push could not be read", { reason: "push.unreadable" })
  }
  return { files, unsupported }
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
          const written = await replaceLocal(file, prepared.local)
          if (!written) {
            result.conflicts.push({ path: file.path, url: entry.url, reason: "the local file changed during the sync" })
            continue
          }
          hash = written
          result.pulled.push(file.path)
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
