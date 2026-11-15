import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type { DocumentSource, SourceFile, SourceState, SourceWalk, SourceWork } from "../../documents/model.js"
import { inScope, type SourceQuery, within } from "../../documents/scope.js"
import type { SyncOptions } from "./ports.js"
// Without a query or pages the hash stays what it was, so a profile that never set them keeps its checkpoint. Turning
// pages on changes it, so the next sync walks again and imports the pages an incremental one would never revisit.
export const scopeHash = (roots: string[], query?: Pick<SourceQuery, "key" | "mode">, pages = false) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        query || pages ? [[...roots].sort(), query?.mode, query?.key, ...(pages ? ["pages"] : [])] : [...roots].sort(),
      ),
    )
    .digest("hex")
export const changedSince = (previous: SourceFile, file: SourceFile) =>
  previous.version !== file.version ||
  previous.modifiedAt !== file.modifiedAt ||
  previous.name !== file.name ||
  previous.canDownload !== file.canDownload ||
  JSON.stringify(previous.parents) !== JSON.stringify(file.parents)

const SAVE_EVERY_MS = 2000
interface WalkStore<M extends SourceFile> {
  read: (scope: string) => SourceWalk<M> | undefined
  save: (walk: SourceWalk<M>) => void
}
export type WalkStop = "entries" | "requests" | "deadline" | "cancelled"
/** A folder walk this call stopped before its end, saved for the next sync to go on from. */
export interface WalkProgress {
  folders_left: number
  /** Entries the walk has found over every call so far. */
  entries: number
  /** Folders this call listed: 0 means it moved nothing on. */
  listed: number
  stopped: WalkStop
}
export type Plan<M extends SourceFile> = { pending: NonNullable<SourceState<M>["pending"]> } | { walk: WalkProgress }

// A round of changes is saved under its own scope: a CLI that validates the walk file keeps only the fields it knows,
// and these say both what the walk is and which cursor it started from.
const changesScope = (scope: string, cursor: string) => `${scope}:changes:${cursor}`

export const planDocuments = async <M extends SourceFile>(
  options: SyncOptions<M>,
  source: DocumentSource<M> | undefined,
  state: SourceState<M>,
  roots: string[],
  limit: number,
  pictures: boolean,
  walks?: WalkStore<M>,
): Promise<Plan<M>> => {
  const { isFolder, skipReason, retryable, maxEntries, errorOf, query, budget } = options
  const scope = scopeHash(roots, query, options.isDocument !== undefined)
  if (!roots.length && query?.mode !== "include")
    return {
      pending: {
        scope,
        cursor: state.cursor ?? "",
        folders: {},
        skipped: [],
        jobs: Object.keys(state.documents).map((id) => ({ id, kind: "remove" })),
      },
    }
  if (!source)
    throw new CliError("configuration_error", "selected folders or a saved query require an authenticated source")
  if (query?.mode === "include" && !query.list)
    throw new CliError("configuration_error", "a query that includes files must list them")
  const initial = !state.cursor || scope !== state.scope
  const resumed = walks?.read(initial ? scope : changesScope(scope, state.cursor as string))
  const folders: Record<string, M> = initial ? {} : structuredClone(state.folders)
  const files = new Map<string, M>(Object.values(state.documents).map((doc) => [doc.metadata.id, doc.metadata]))
  const changed = new Set<string>()
  // What the walk saves: every file of a full walk, or what a round of changes touched, a removed file as trashed.
  const delta = new Map<string, M>()
  for (const skipped of state.skipped) if (skipped.file) files.set(skipped.id, skipped.file)
  if (initial) files.clear()
  const keep = (file: M) => {
    files.set(file.id, file)
    changed.add(file.id)
    delta.set(file.id, file)
  }
  const drop = (id: string) => {
    const known = files.get(id)
    if (known) delta.set(id, { ...known, trashed: true })
    files.delete(id)
  }
  const container = (file: M) => {
    if (options.isDocument?.(file)) keep(file)
  }
  // A folder the last finished pass walked keeps its subtree: a round lists only its direct children, and the
  // source's changes name what changed below them. A new, restored or moved-in folder is walked in full.
  const walked = (id: string) => !initial && state.folders[id] !== undefined && !state.folders[id]?.trashed
  let walk = resumed
  let cursor = state.cursor ?? ""
  if (!walk && initial) {
    const start = await source.startToken()
    walk = {
      scope,
      cursor: start,
      stack: [...roots].reverse().map((id) => ({ id, ancestry: [] })),
      visited: [],
      folders: {},
      files: [],
      discovered: 0,
    }
  } else if (!walk) {
    const page = await source.changes(cursor)
    const latest = new Map(page.items.map((change) => [change.id, change]))
    const entering: M[] = []
    // Apply all ancestry changes before classifying document scope.
    for (const change of latest.values()) {
      if (change.removed || change.file?.trashed) {
        drop(change.id)
        if (folders[change.id]) folders[change.id] = { ...(folders[change.id] as M), trashed: true }
      } else if (change.file && isFolder(change.file)) {
        folders[change.id] = change.file
        entering.push(change.file)
        container(change.file)
      } else if (change.file) keep(change.file)
      else if (state.documents[change.id] || folders[change.id])
        throw new CliError("invalid_response", "known source changed without metadata; checkpoint preserved")
    }
    // Provider access changes may not emit an event for every descendant file.
    for (const root of roots) {
      const previous = folders[root]
      try {
        const current = await source.metadata(root)
        if (current.id !== root || !isFolder(current))
          throw new CliError("invalid_response", "selected folder metadata is inconsistent")
        folders[root] = current
        if (previous?.trashed && !current.trashed) entering.push(current)
      } catch (error) {
        const safe = errorOf(error)
        if (safe.code !== "not_found" || !previous) throw safe
        folders[root] = { ...previous, trashed: true }
      }
    }
    const stack = entering
      .filter((folder) => within(folder, roots, folders))
      .reverse()
      .map((folder) => ({ id: folder.id, ancestry: [], folder }))
    if (stack.length)
      walk = {
        scope: changesScope(scope, cursor),
        cursor: page.cursor,
        stack,
        visited: [],
        folders: {},
        files: [],
        discovered: 0,
      }
    else cursor = page.cursor
  }
  const vanished = async (id: string) => {
    try {
      return (await source.metadata(id)).trashed
    } catch (error) {
      return errorOf(error).code === "not_found"
    }
  }
  let found: M[] = []
  if (walk) {
    const visited = new Set(walk.visited)
    Object.assign(folders, walk.folders)
    for (const file of walk.files) {
      if (file.trashed) drop(file.id)
      else keep(file)
    }
    cursor = walk.cursor
    const now = options.now ?? Date.now
    let savedAt = now()
    const current = walk
    const record = () => {
      walks?.save({ ...current, visited: [...visited], folders, files: [...delta.values()] })
      savedAt = now()
    }
    let spent = 0
    let listed = 0
    let stopped: WalkStop | null = null
    try {
      for (let step = walk.stack.at(-1); step; step = walk.stack.at(-1)) {
        if (step.ancestry.includes(step.id)) throw new CliError("invalid_response", "folder traversal contains a cycle")
        if (visited.has(step.id)) {
          walk.stack.pop()
          continue
        }
        // One folder at least per call, so a folder with more children than the bound still gets listed.
        // The run's own signal too: a cooperative sync is not cut from outside, and a CLI may pass no budget.
        stopped = options.signal?.aborted
          ? "cancelled"
          : listed > 0 && spent >= maxEntries
            ? "entries"
            : (budget?.take() ?? null)
        if (stopped) break
        const folder = step.folder ?? (await source.metadata(step.id))
        if (!step.folder && (!isFolder(folder) || folder.trashed))
          throw new CliError("validation_error", "configured root is not an accessible folder")
        if (!step.folder) container(folder)
        let children: M[]
        try {
          children = await source.children(folder.id)
        } catch (error) {
          // Deleted or unshared since the walk saved it: gone, with what is below it, instead of failing every sync.
          // A listing's 404 alone can be passing, so the folder is read again and is gone only when that read is a
          // 404 too or finds it trashed; on any doubt the call fails and the next sync lists it again.
          if (errorOf(error).code !== "not_found" || !(await vanished(folder.id))) throw error
          walk.stack.pop()
          visited.add(folder.id)
          folders[folder.id] = { ...folder, trashed: true }
          drop(folder.id)
          spent++
          listed++
          continue
        }
        spent += 1 + children.length
        listed++
        walk.discovered += children.length
        walk.stack.pop()
        visited.add(folder.id)
        folders[folder.id] = folder
        const nested = []
        for (const file of children)
          if (isFolder(file)) {
            container(file)
            if (walked(file.id)) folders[file.id] = file
            else nested.push({ id: file.id, ancestry: [...step.ancestry, folder.id], folder: file })
          } else keep(file)
        for (const entry of nested.reverse()) walk.stack.push(entry)
        if (now() - savedAt > SAVE_EVERY_MS) record()
      }
      if (stopped) {
        record()
        return {
          walk: { folders_left: walk.stack.length, entries: walk.discovered, listed, stopped },
        }
      }
      // Listed once the walk is done: a call the walk does not finish would read it for nothing.
      if (query?.mode === "include" && query.list) found = await query.list()
    } catch (error) {
      record()
      throw error
    }
  } else if (query?.mode === "include" && query.list) found = await query.list()
  const matched = new Set<string>()
  for (const file of found) {
    if (
      (isFolder(file) && !options.isDocument?.(file)) ||
      file.trashed ||
      !query?.matches(file) ||
      matched.has(file.id)
    )
      continue
    // Listed again on every sync, so only a new or changed file is work; a skipped one keeps its skip.
    const prior = state.documents[file.id]?.metadata ?? state.skipped.find((item) => item.id === file.id)?.file
    if (initial || !prior || changedSince(prior, file)) changed.add(file.id)
    files.set(file.id, file)
    matched.add(file.id)
  }
  const jobs: SourceWork<M>[] = []
  const skipped: SourceState<M>["skipped"] = []
  for (const root of roots)
    if (folders[root]?.trashed) skipped.push({ id: root, reason: "selected folder is unavailable" })
  for (const [id, file] of files) {
    if (!inScope(file, roots, folders, matched, query)) continue
    const previousSkip = state.skipped.find((item) => item.id === id)
    const reason = skipReason(file)
    const retry = previousSkip && !reason && retryable(previousSkip, limit)
    const known = state.documents[id]
    const pictureDue =
      pictures && file.mime.startsWith("image/") && file.canDownload && known !== undefined && !known.picture
    if (previousSkip && !changed.has(id) && !initial && !retry && !pictureDue && !(reason && !state.documents[id])) {
      skipped.push({ ...previousSkip, file })
      continue
    }
    if (reason) {
      skipped.push({ id, reason, file })
      if (initial || !known || known.notRead !== reason || changedSince(known.metadata, file) || pictureDue)
        jobs.push({ id, kind: "save", file })
      continue
    }
    if (changed.has(id) || retry || known?.notRead) {
      if (!known || known.notRead || changedSince(known.metadata, file) || initial)
        jobs.push({ id, kind: "save", file })
    }
  }
  for (const id of Object.keys(state.documents)) {
    const file = files.get(id)
    if (!file || !inScope(file, roots, folders, matched, query)) jobs.push({ id, kind: "remove" })
  }
  // Only retain metadata for selected ancestry; the account-wide feed includes unrelated folders.
  const scopedFolders = Object.fromEntries(
    Object.entries(folders).filter(([, file]) => within(file, roots, folders) || roots.includes(file.id)),
  )
  return {
    pending: {
      scope,
      cursor,
      folders: scopedFolders,
      jobs,
      skipped,
      ...(query?.mode === "include" ? { matched: [...matched] } : {}),
    },
  }
}
