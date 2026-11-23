import { join } from "node:path"
import * as v from "valibot"
import type { FileMirrorState, FileMirrorStatePort } from "../../documents/file-mirror-model.js"
import { jsonState, type Mirror } from "../documents/mirrors.js"
import { excludedBy } from "./exclusions.js"
import { listingSchema, remoteFileSchema } from "./listing.js"
import { scan, under } from "./local-files.js"

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
  listing: v.optional(listingSchema),
  conflicts: v.optional(
    v.record(
      v.string(),
      v.object({
        reason: v.string(),
        at: v.string(),
        base: v.optional(v.string()),
        local: v.optional(v.string()),
        remote: v.optional(v.string()),
        remoteFile: v.optional(remoteFileSchema),
        kept: v.optional(v.boolean()),
      }),
    ),
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
