import * as v from "valibot"
import type { FileMirrorState, FileTarget, RemoteFile } from "../../documents/file-mirror-model.js"

/**
 * A stopped listing older than this starts over. Staleness costs a conflict or a deletion found a run later, never
 * data; the bound is days so that a sync run once a day still finishes a listing that takes several runs.
 */
const MAX_LISTING_AGE_MS = 7 * 24 * 3_600_000

/**
 * The remote listing, gone on from where the last run's stopped, and what to save of it when it is incomplete. This
 * run's files win over the saved ones by path and by id, so a file met twice, or moved between runs, is kept once at
 * its latest path.
 */
export const listRemote = async (
  target: FileTarget,
  folder: string,
  signal: AbortSignal | undefined,
  excluded: (path: string) => boolean,
  saved: FileMirrorState["listing"],
  now: number,
  maxFiles: number,
): Promise<{
  listed?: { rootId: string; files: RemoteFile[]; complete: boolean }
  progress?: FileMirrorState["listing"]
}> => {
  const resumed = saved && now - Date.parse(saved.startedAt) <= MAX_LISTING_AGE_MS ? saved : undefined
  const listed = await target.list(folder, signal, { excluded, ...(resumed ? { from: resumed.next } : {}) })
  if (!listed) return {}
  const { rootId, next } = listed
  // Its pages went on part-way through another folder, so they are not a whole listing of this one.
  if (resumed && rootId !== resumed.rootId) return { listed: { rootId, files: listed.files, complete: false } }
  const paths = new Set(listed.files.map((file) => file.path))
  const ids = new Set(listed.files.map((file) => file.id))
  const files = resumed
    ? [...resumed.files.filter((file) => !paths.has(file.path) && !ids.has(file.id)), ...listed.files]
    : listed.files
  if (resumed && files.filter((file) => !excluded(file.path)).length > maxFiles)
    return { listed: { rootId, files, complete: false } }
  const startedAt = resumed?.startedAt ?? new Date(now).toISOString()
  return {
    listed: { rootId, files, complete: listed.complete },
    ...(!listed.complete && next !== undefined ? { progress: { rootId, startedAt, next, files } } : {}),
  }
}

const remoteFileSchema = v.object({
  path: v.string(),
  id: v.string(),
  size: v.number(),
  sha256: v.optional(v.string()),
  md5: v.optional(v.string()),
  modifiedAt: v.string(),
})
export const listingSchema = v.object({
  rootId: v.string(),
  startedAt: v.string(),
  next: v.string(),
  files: v.array(remoteFileSchema),
})
