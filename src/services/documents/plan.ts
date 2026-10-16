import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type { DocumentSource, SourceFile, SourceState, SourceWalk, SourceWork } from "../../documents/model.js"
import { within } from "../../documents/scope.js"
import type { SyncOptions } from "./ports.js"
export const scopeHash = (roots: string[]) =>
  createHash("sha256")
    .update(JSON.stringify([...roots].sort()))
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

export const planDocuments = async <M extends SourceFile>(
  options: SyncOptions<M>,
  source: DocumentSource<M> | undefined,
  state: SourceState<M>,
  roots: string[],
  limit: number,
  pictures: boolean,
  abandoned: string[] = [],
  walks?: WalkStore<M>,
): Promise<NonNullable<SourceState<M>["pending"]>> => {
  const { isFolder, skipReason, retryable, maxEntries: MAX_ENTRIES, errorOf } = options
  const tooManyEntries = () =>
    options.limitError?.() ?? new CliError("validation_error", `selected folders exceed the ${MAX_ENTRIES} entry limit`)
  const scope = scopeHash(roots)
  if (!roots.length)
    return {
      scope,
      cursor: state.cursor ?? "",
      folders: {},
      skipped: [],
      jobs: [...new Set([...Object.keys(state.documents), ...abandoned])].map((id) => ({ id, kind: "remove" })),
    }
  if (!source) throw new CliError("configuration_error", "selected folders require an authenticated source")
  const initial = !state.cursor || scope !== state.scope
  const resumed = initial ? walks?.read(scope) : undefined
  const cursor = initial ? (resumed?.cursor ?? (await source.startToken())) : (state.cursor as string)
  const folders: Record<string, M> = initial ? {} : structuredClone(state.folders)
  const files = new Map<string, M>(Object.values(state.documents).map((doc) => [doc.metadata.id, doc.metadata]))
  const changed = new Set<string>()
  for (const skipped of state.skipped) if (skipped.file) files.set(skipped.id, skipped.file)
  const visited = new Set<string>()
  let discovered = 0
  const crawl = async (folder: M, ancestry = new Set<string>()): Promise<void> => {
    if (ancestry.has(folder.id)) throw new CliError("invalid_response", "folder traversal contains a cycle")
    if (visited.has(folder.id)) return
    visited.add(folder.id)
    folders[folder.id] = folder
    for (const file of await source.children(folder.id)) {
      if (++discovered > MAX_ENTRIES) throw tooManyEntries()
      if (isFolder(file)) await crawl(file, new Set([...ancestry, folder.id]))
      else {
        files.set(file.id, file)
        changed.add(file.id)
      }
    }
  }
  let finalCursor = cursor
  if (initial) {
    files.clear()
    const walk: SourceWalk<M> = resumed ?? {
      scope,
      cursor,
      stack: [...roots].reverse().map((id) => ({ id, ancestry: [] })),
      visited: [],
      folders: {},
      files: [],
      discovered: 0,
    }
    for (const id of walk.visited) visited.add(id)
    Object.assign(folders, walk.folders)
    for (const file of walk.files) {
      files.set(file.id, file)
      changed.add(file.id)
    }
    discovered = walk.discovered
    let savedAt = (options.now ?? Date.now)()
    const record = () => {
      walks?.save({ ...walk, visited: [...visited], folders, files: [...files.values()], discovered })
      savedAt = (options.now ?? Date.now)()
    }
    try {
      for (let step = walk.stack.at(-1); step; step = walk.stack.at(-1)) {
        if (step.ancestry.includes(step.id)) throw new CliError("invalid_response", "folder traversal contains a cycle")
        if (visited.has(step.id)) {
          walk.stack.pop()
          continue
        }
        const folder = step.folder ?? (await source.metadata(step.id))
        if (!step.folder && (!isFolder(folder) || folder.trashed))
          throw new CliError("validation_error", "configured root is not an accessible folder")
        const children = await source.children(folder.id)
        if (discovered + children.length > MAX_ENTRIES) throw tooManyEntries()
        discovered += children.length
        walk.stack.pop()
        visited.add(folder.id)
        folders[folder.id] = folder
        const nested = []
        for (const file of children)
          if (isFolder(file)) nested.push({ id: file.id, ancestry: [...step.ancestry, folder.id], folder: file })
          else {
            files.set(file.id, file)
            changed.add(file.id)
          }
        for (const entry of nested.reverse()) walk.stack.push(entry)
        if ((options.now ?? Date.now)() - savedAt > SAVE_EVERY_MS) record()
      }
    } catch (error) {
      record()
      throw error
    }
  } else {
    const page = await source.changes(cursor)
    finalCursor = page.cursor
    const latest = new Map(page.items.map((change) => [change.id, change]))
    const entering: M[] = []
    // Apply all ancestry changes before classifying document scope.
    for (const change of latest.values()) {
      if (change.removed || change.file?.trashed) {
        files.delete(change.id)
        if (folders[change.id]) folders[change.id] = { ...(folders[change.id] as M), trashed: true }
      } else if (change.file && isFolder(change.file)) {
        folders[change.id] = change.file
        entering.push(change.file)
      } else if (change.file) {
        files.set(change.id, change.file)
        changed.add(change.id)
      } else if (state.documents[change.id] || folders[change.id])
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
    for (const folder of entering) if (!visited.has(folder.id) && within(folder, roots, folders)) await crawl(folder)
  }
  const jobs: SourceWork<M>[] = []
  const skipped: SourceState<M>["skipped"] = []
  for (const root of roots)
    if (folders[root]?.trashed) skipped.push({ id: root, reason: "selected folder is unavailable" })
  for (const [id, file] of files) {
    if (!within(file, roots, folders)) continue
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
  for (const id of new Set([...Object.keys(state.documents), ...abandoned])) {
    const file = files.get(id)
    if (!file || !within(file, roots, folders)) jobs.push({ id, kind: "remove" })
  }
  // Only retain metadata for selected ancestry; the account-wide feed includes unrelated folders.
  const scopedFolders = Object.fromEntries(
    Object.entries(folders).filter(([, file]) => within(file, roots, folders) || roots.includes(file.id)),
  )
  return { scope, cursor: finalCursor, folders: scopedFolders, jobs, skipped }
}
