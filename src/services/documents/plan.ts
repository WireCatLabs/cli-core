import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import {
  type FeedlessDocumentSource,
  feedOf,
  type IndexedSource,
  type SourceFile,
  type SourceRemoval,
  type SourceState,
  type SourceWalk,
  type SourceWork,
} from "../../documents/model.js"
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
/** Saved documents a source asks to read again, at most, in one pass. */
export const REREAD_BATCH = 50
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
  /** Listings this call made (a folder, or one page of it): 0 means it moved nothing on. */
  listed: number
  stopped: WalkStop
}
export type Plan<M extends SourceFile> = { pending: NonNullable<SourceState<M>["pending"]> } | { walk: WalkProgress }

// What a pass of a source without a change feed records as its cursor: the next pass is not a first one, so it saves
// only what changed.
export const WALKED = "walked"
// A round of changes is saved under its own scope: a CLI that validates the walk file keeps only the fields it knows,
// and these say both what the walk is and which cursor it started from.
const changesScope = (scope: string, cursor: string) => `${scope}:changes:${cursor}`

export const planDocuments = async <M extends SourceFile>(
  options: SyncOptions<M>,
  source: FeedlessDocumentSource<M> | undefined,
  state: SourceState<M>,
  roots: string[],
  limit: number,
  pictures: boolean,
  walks?: WalkStore<M>,
): Promise<Plan<M>> => {
  const { isFolder, skipReason, retryable, maxEntries, errorOf, query, budget } = options
  const answers = new Map<string, boolean>()
  // Asked once per node, as every file below a folder asks about it again on its way up.
  const cut =
    query?.mode === "exclude"
      ? (file: M) => {
          const known = answers.get(file.id)
          if (known !== undefined) return known
          const found = query.matches(file)
          answers.set(file.id, found)
          return found
        }
      : undefined
  const scoped = cut && query ? { ...query, matches: cut } : query
  const excluded = (folder: M) => !roots.includes(folder.id) && cut?.(folder) === true
  const scope = scopeHash(roots, query, options.isDocument !== undefined)
  if (!roots.length && query?.mode !== "include")
    return {
      pending: {
        scope,
        cursor: state.cursor ?? "",
        folders: {},
        skipped: [],
        jobs: Object.keys(state.documents).map((id) => ({ id, kind: "remove", reason: "unsynced" })),
      },
    }
  if (!source)
    throw new CliError("configuration_error", "selected folders or a saved query require an authenticated source")
  if (query?.mode === "include" && !query.list)
    throw new CliError("configuration_error", "a query that includes files must list them")
  const initial = !state.cursor || scope !== state.scope
  // Without a feed every pass walks the whole tree again; only a first one saves every file.
  const feed = feedOf(source)
  const full = initial || !feed
  const resumed = walks?.read(full ? scope : changesScope(scope, state.cursor as string))
  const folders: Record<string, M> = full ? {} : structuredClone(state.folders)
  const files = new Map<string, M>(Object.values(state.documents).map((doc) => [doc.metadata.id, doc.metadata]))
  const changed = new Set<string>()
  // What the walk saves: every file of a full walk, or what a round of changes touched, a removed file as trashed.
  const delta = new Map<string, M>()
  for (const skipped of state.skipped) if (skipped.file) files.set(skipped.id, skipped.file)
  if (full) files.clear()
  // A pass without a feed lists every file again; only one new or changed since the last pass is work, so a file kept
  // by name only is not read again each sync. A changed path (a folder renamed above it) counts as a change.
  const prior = (id: string) => state.documents[id]?.metadata ?? state.skipped.find((item) => item.id === id)?.file
  const moved = (before: M, file: M) =>
    JSON.stringify(before.providerMetadata ?? null) !== JSON.stringify(file.providerMetadata ?? null)
  const keep = (file: M) => {
    files.set(file.id, file)
    const before = feed || initial ? undefined : prior(file.id)
    if (!before || changedSince(before, file) || moved(before, file)) changed.add(file.id)
    delta.set(file.id, file)
  }
  const removals = new Map<string, SourceRemoval>()
  const drop = (id: string, reason: SourceRemoval) => {
    const known = files.get(id)
    if (known) delta.set(id, { ...known, trashed: true })
    files.delete(id)
    removals.set(id, reason)
  }
  // A listing's own trash is the same signal as the feed's: the row leaves the copy as deleted. A full walk has
  // cleared `files`, so the row goes into the saved walk from here.
  const trash = (file: M) => {
    files.delete(file.id)
    delta.set(file.id, file)
    removals.set(file.id, "deleted")
  }
  const container = (file: M) => {
    if (!options.isDocument?.(file)) return
    if (file.trashed) trash(file)
    else keep(file)
  }
  // A folder the last finished pass walked keeps its subtree: a round lists only its direct children, and the
  // source's changes name what changed below them. A new, restored or moved-in folder is walked in full.
  const walked = (id: string) => !full && state.folders[id] !== undefined && !state.folders[id]?.trashed
  let walk = resumed
  let cursor = state.cursor ?? ""
  // Each read takes a request from the budget, the start token and a root's own metadata as much as a listing: a run
  // that left them out would reach its deadline with no margin.
  const charge = () => {
    const taken = options.signal?.aborted ? "cancelled" : budget?.take()
    return taken === "deadline" && budget?.first?.() ? null : (taken ?? null)
  }
  if (!walk && full) {
    const before = charge()
    if (before) return { walk: { folders_left: roots.length, entries: 0, listed: 0, stopped: before } }
    const start = feed ? await feed.startToken() : WALKED
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
    // The roots' metadata below stays free: a run stopped between them and the changes would read the same page again
    // in every call.
    const before = charge()
    if (before) return { walk: { folders_left: 0, entries: 0, listed: 0, stopped: before } }
    const page = await (feed as NonNullable<typeof feed>).changes(cursor)
    const latest = new Map(page.items.map((change) => [change.id, change]))
    const entering: M[] = []
    // Apply all ancestry changes before classifying document scope.
    for (const change of latest.values()) {
      if (change.removed || change.file?.trashed) {
        drop(change.id, change.file?.trashed ? "deleted" : (change.gone ?? "unavailable"))
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
        const current = await source.metadata(root, folders[root])
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
      .filter((folder) => !excluded(folder) && within(folder, roots, folders, new Set(), cut))
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
  const vanished = async (id: string, known: M) => {
    try {
      return (await source.metadata(id, known)).trashed
    } catch (error) {
      return errorOf(error).code === "not_found"
    }
  }
  let found: M[] = []
  if (walk) {
    const visited = new Set(walk.visited)
    const deleted = new Set(walk.deleted)
    Object.assign(folders, walk.folders)
    for (const file of walk.files) {
      // One the saved walk cannot prove is a deletion keeps the text.
      if (file.trashed && deleted.has(file.id)) trash(file)
      else if (file.trashed) drop(file.id, "unavailable")
      else keep(file)
    }
    cursor = walk.cursor
    const now = options.now ?? Date.now
    let savedAt = now()
    const current = walk
    const record = () => {
      const deleted = [...removals].flatMap(([id, reason]) => (reason === "deleted" && delta.has(id) ? [id] : []))
      walks?.save({
        ...current,
        visited: [...visited],
        folders,
        files: [...delta.values()],
        ...(deleted.length ? { deleted } : {}),
      })
      savedAt = now()
    }
    let spent = 0
    let listed = 0
    let stopped: WalkStop | null = null
    type Step = (typeof current.stack)[number]
    type Listed =
      | { kind: "root-gone" }
      | { kind: "root"; stopped: WalkStop }
      | { kind: "listed"; children: M[]; more?: string }
      | { kind: "relist" }
      | { kind: "gone" }
    // A value that is not a whole number would leave the batch empty and end the walk as if it found nothing.
    const asked = source.parallelListings
    const width = Number.isInteger(asked) && (asked as number) > 1 ? Math.min(asked as number, 8) : 1
    // A root read in a listing that then fails is still filed, as the walk saves it on the step.
    const rootsRead = new Map<Step, M>()
    const list = async (step: Step): Promise<Listed> => {
      if (!step.folder) {
        let root: M
        try {
          root = await source.metadata(step.id, state.folders[step.id])
        } catch (error) {
          // Without a feed, a folder the last pass held and the provider no longer finds is skipped as unavailable,
          // as a round of changes does, so a moved or deleted root does not fail every sync. A source with a feed
          // walks in full only on a rescan, where a root it cannot read still fails and keeps what it holds.
          if (feed || !state.folders[step.id] || errorOf(error).code !== "not_found") throw error
          return { kind: "root-gone" }
        }
        if (!isFolder(root) || root.trashed)
          throw new CliError("validation_error", "configured root is not an accessible folder")
        rootsRead.set(step, root)
        // Kept on the step, so a call stopped before the listing does not read the root again.
        step.folder = root
        const after = charge()
        if (after) return { kind: "root", stopped: after }
      }
      const folder = step.folder
      try {
        if (!source.childrenPage) return { kind: "listed", children: await source.children(folder.id, folder) }
        const page = await source.childrenPage(folder.id, step.listing, folder)
        return { kind: "listed", children: page.files, ...(page.cursor ? { more: page.cursor } : {}) }
      } catch (error) {
        if (errorOf(error).code !== "not_found") throw error
        // A later page's 404 can be a cursor the provider no longer knows: the folder is listed again from its first
        // page, which tells a gone folder from a stale cursor, and the files already kept are only kept again.
        if (step.listing !== undefined) return { kind: "relist" }
        // Deleted or unshared since the walk saved it: gone, with what is below it, instead of failing every sync.
        // A listing's 404 alone can be passing, so the folder is read again and is gone only when that read is a
        // 404 too or finds it trashed; on any doubt the call fails and the next sync lists it again.
        if (!(await vanished(folder.id, folder))) throw error
        return { kind: "gone" }
      }
    }
    // In the step's own place, so the stack keeps the order a walk one folder at a time has.
    const place = (step: Step, entries: Step[]) => current.stack.splice(current.stack.indexOf(step), 1, ...entries)
    const apply = (step: Step, result: Listed) => {
      if (result.kind === "root") {
        stopped ??= result.stopped
        return
      }
      spent++
      listed++
      if (result.kind === "relist") {
        delete step.listing
        return
      }
      if (result.kind === "root-gone") {
        place(step, [])
        visited.add(step.id)
        folders[step.id] = { ...(state.folders[step.id] as M), trashed: true }
        return
      }
      const folder = step.folder as M
      if (result.kind === "gone") {
        place(step, [])
        visited.add(folder.id)
        folders[folder.id] = { ...folder, trashed: true }
        drop(folder.id, "unavailable")
        return
      }
      const { children, more } = result
      spent += children.length
      current.discovered += children.length
      folders[folder.id] = folder
      const nested = []
      for (const file of children)
        if (isFolder(file)) {
          container(file)
          if (excluded(file)) continue
          if (walked(file.id)) folders[file.id] = file
          else nested.push({ id: file.id, ancestry: [...step.ancestry, folder.id], folder: file })
        } else if (file.trashed) trash(file)
        else keep(file)
      // A folder with more pages goes back on top with its cursor, above its child folders.
      place(step, [...nested.reverse(), ...(more ? [{ ...step, folder, listing: more }] : [])])
      if (!more) visited.add(folder.id)
    }
    const done = (step: Step) => {
      if (step.ancestry.includes(step.id)) throw new CliError("invalid_response", "folder traversal contains a cycle")
      return visited.has(step.id)
    }
    try {
      for (;;) {
        for (let top = current.stack.at(-1); top && done(top); top = current.stack.at(-1)) current.stack.pop()
        // The folders at the top of the stack, listed together on a source that allows it; each takes its request
        // before it starts, so the budget and the deadline bound the batch as they bound one listing.
        const batch: Step[] = []
        for (let at = current.stack.length - 1; at >= 0 && batch.length < width; at--) {
          const step = current.stack[at] as Step
          if (done(step) || batch.some((one) => one.id === step.id)) continue
          // One listing at least per call, so a folder with more children than the bound still moves on.
          // The run's own signal too: a cooperative sync is not cut from outside, and a CLI may pass no budget.
          // The time budget keeps a margin of 5 s or more, so a short run would never list a folder: its first
          // request goes ahead while one still fits before the deadline itself.
          const taken = options.signal?.aborted
            ? "cancelled"
            : (listed > 0 || batch.length > 0) && spent >= maxEntries
              ? "entries"
              : budget?.take()
          stopped = taken === "deadline" && budget?.first?.() ? null : (taken ?? null)
          if (stopped) break
          batch.push(step)
        }
        if (!batch.length) break
        const results = await Promise.allSettled(batch.map(list))
        let failure: { reason: unknown } | undefined
        batch.forEach((step, at) => {
          const root = rootsRead.get(step)
          if (root) container(root)
          rootsRead.delete(step)
          const result = results[at] as PromiseSettledResult<Listed>
          if (result.status === "fulfilled") apply(step, result.value)
          else failure ??= { reason: result.reason }
        })
        if (failure) throw failure.reason
        if (stopped) break
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
    if ((isFolder(file) && !options.isDocument?.(file)) || !query?.matches(file) || matched.has(file.id)) continue
    if (file.trashed) {
      files.delete(file.id)
      removals.set(file.id, "deleted")
      continue
    }
    // Listed again on every sync, so only a new or changed file is work; a skipped one keeps its skip.
    const prior = state.documents[file.id]?.metadata ?? state.skipped.find((item) => item.id === file.id)?.file
    if (initial || !prior || changedSince(prior, file)) changed.add(file.id)
    files.set(file.id, file)
    matched.add(file.id)
  }
  const jobs: SourceWork<M>[] = []
  const skipped: SourceState<M>["skipped"] = []
  const again: SourceWork<M>[] = []
  let rereads = 0
  const extractor = options.scans?.extractor
  // OCR text from another engine or model is read again; turning OCR off keeps it.
  const ocrStale = (known: IndexedSource<M>) =>
    known.ocr !== undefined && extractor !== undefined && known.ocr !== extractor
  const reread = (known: IndexedSource<M> | undefined) =>
    known !== undefined &&
    !known.notRead &&
    rereads < REREAD_BATCH &&
    (ocrStale(known) || source.reread?.(known) === true) &&
    ++rereads > 0
  for (const root of roots)
    if (folders[root]?.trashed) skipped.push({ id: root, reason: "selected folder is unavailable" })
  for (const [id, file] of files) {
    if (!inScope(file, roots, folders, matched, scoped)) continue
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
      if (
        !known ||
        known.notRead ||
        changedSince(known.metadata, file) ||
        initial ||
        (!feed && moved(known.metadata, file))
      )
        jobs.push({ id, kind: "save", file })
      else if (reread(known)) again.push({ id, kind: "save", file })
    } else if (reread(known)) again.push({ id, kind: "save", file })
  }
  // After every real edit, so a run that stops on its deadline spends it on those first.
  for (const job of again) jobs.push(job)
  // Absent from the listing is not a deletion: only the source's own signal is (`drop`, `trash`). Out of scope is
  // `unsynced` only when the owner changed the scope; a folder above that was unshared or vanished leaves its files
  // unavailable.
  const narrowed = state.scope !== scope
  for (const id of Object.keys(state.documents)) {
    const file = files.get(id)
    const known = file ?? state.documents[id]?.metadata
    if (file && inScope(file, roots, folders, matched, scoped)) continue
    const outside = narrowed && known !== undefined && !inScope(known, roots, folders, matched, scoped)
    jobs.push({ id, kind: "remove", reason: removals.get(id) ?? (outside ? "unsynced" : "unavailable") })
  }
  // Only retain metadata for selected ancestry; the account-wide feed includes unrelated folders.
  const scopedFolders = Object.fromEntries(
    Object.entries(folders).filter(
      ([, file]) => roots.includes(file.id) || (!excluded(file) && within(file, roots, folders, new Set(), cut)),
    ),
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
