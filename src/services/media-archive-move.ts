import { realpath, unlink } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { openOrdinaryFile, sameOrdinaryFile, syncDirectory, writeFileAtomic } from "../files/index.js"
import { validateMediaSince } from "./media-archive.js"
import { archiveMediaFile } from "./media-archive-files.js"
import { withMediaArchiveLocks } from "./media-archive-locks.js"
import {
  type MediaArchiveEntry,
  mediaFingerprint,
  mediaKey,
  mediaManifestName,
  missingMediaFile,
  parseMediaEntry,
  readMediaManifests,
  sameMediaCopy,
  verifyMediaEntry,
} from "./media-archive-manifest.js"

export interface MoveMediaArchiveOptions {
  directory: string
  archiveDirectory: string
  beforeTime: string
  dryRun?: boolean
  signal?: AbortSignal
}
const canonicalDestination = async (directory: string): Promise<string> => {
  const path = resolve(directory)
  try {
    return await realpath(path)
  } catch (error) {
    if (!missingMediaFile(error) || dirname(path) === path) throw error
    return join(await canonicalDestination(dirname(path)), basename(path))
  }
}
const image = (entry: MediaArchiveEntry) => ["photo", "image"].includes(entry.kind) || entry.mime?.startsWith("image/")

const removeLocalCopy = async (
  root: string,
  entry: MediaArchiveEntry,
  beforeWrite: () => Promise<void>,
  signal?: AbortSignal,
) => {
  const path = join(root, entry.path)
  let file: Awaited<ReturnType<typeof openOrdinaryFile>>
  try {
    file = await openOrdinaryFile(path)
  } catch (error) {
    if (missingMediaFile(error)) return
    throw error
  }
  try {
    const identity = await file.stat({ bigint: true })
    const proof = await mediaFingerprint(path, signal)
    if (proof.size !== entry.size || proof.sha256 !== entry.sha256 || !(await sameOrdinaryFile(path, identity)))
      throw new CliError("validation_error", "local image changed during rotation; it was preserved")
    if (!(await verifyMediaEntry(root, entry, signal)))
      throw new CliError("validation_error", "rotated image checksum mismatch; the local copy was preserved")
    await beforeWrite()
    if (!(await sameOrdinaryFile(path, identity)))
      throw new CliError("validation_error", "local image was replaced; it was preserved")
    await unlink(path)
    await syncDirectory(root)
  } finally {
    await file.close()
  }
}

/** The destination is durable before a source relocation record is published, then the verified local copy is removed. */
export const moveMediaArchive = async (options: MoveMediaArchiveOptions) => {
  const cutoff = validateMediaSince(options.beforeTime, "--before-time")
  if (cutoff === undefined) throw new CliError("validation_error", "--before-time is required")
  const target = await canonicalDestination(options.archiveDirectory)
  const source = await realpath(options.directory)
  if (source === target) throw new CliError("validation_error", "choose a different archive destination")
  return withMediaArchiveLocks(
    source,
    options.signal,
    async (root, beforeWrite) => {
      const entries = await readMediaManifests(root, options.signal)
      if (!entries.length) throw new CliError("not_found", "no media archive manifests in this directory")
      const targetEntries = await readMediaManifests(target, options.signal).catch((error: unknown) => {
        if (options.dryRun && missingMediaFile(error)) return []
        throw error
      })
      for (const [folder, manifests] of [
        [root, entries],
        [target, targetEntries],
      ] as const)
        for (const entry of manifests) {
          let valid = false
          try {
            valid = await verifyMediaEntry(folder, entry, options.signal)
          } catch {
            options.signal?.throwIfAborted()
          }
          if (!valid)
            throw new CliError("validation_error", "archive checksum mismatch or missing file; no images were moved")
        }
      const known = new Map(targetEntries.map((entry) => [mediaKey(entry), entry]))
      let selected = 0,
        moved = 0,
        movedBytes = 0,
        selectedBytes = 0,
        undated = 0,
        alreadyArchived = 0
      const candidates: MediaArchiveEntry[] = []
      for (const entry of entries) {
        if (!image(entry)) continue
        if (!entry.messageTime) {
          undated++
          continue
        }
        if (Date.parse(entry.messageTime) >= cutoff) continue
        if (entry.relocatedTo) {
          alreadyArchived++
          if (!options.dryRun) await removeLocalCopy(root, entry, beforeWrite, options.signal)
          continue
        }
        const existing = known.get(mediaKey(entry))
        if (existing?.relocatedTo)
          throw new CliError(
            "validation_error",
            "destination image is already relocated; choose its current archive directory",
          )
        if (existing && !sameMediaCopy(entry, existing))
          throw new CliError(
            "validation_error",
            "destination has a different copy of this image; choose a new destination",
          )
        candidates.push(entry)
        selected++
        selectedBytes += entry.size
      }
      if (!options.dryRun)
        for (const entry of candidates) {
          await beforeWrite()
          if (!known.has(mediaKey(entry))) {
            const file = await openOrdinaryFile(join(root, entry.path))
            try {
              const identity = {
                provider: entry.provider,
                account: entry.account,
                chat: entry.chat,
                message: entry.message,
                position: entry.position,
              }
              const copied = await archiveMediaFile(
                target,
                identity,
                entry.kind,
                async () => ({
                  kind: entry.kind,
                  size: entry.size,
                  bytes: () =>
                    file.createReadStream({ autoClose: false, ...(options.signal ? { signal: options.signal } : {}) }),
                }),
                beforeWrite,
                options.signal,
                {
                  messageTime: entry.messageTime,
                  mime: entry.mime,
                  expected: { size: entry.size, sha256: entry.sha256 },
                },
              )
              known.set(mediaKey(entry), copied)
            } finally {
              await file.close()
            }
          }
          const receipt = parseMediaEntry({ ...entry, relocatedTo: target })
          if (!(await verifyMediaEntry(root, receipt, options.signal)))
            throw new CliError(
              "validation_error",
              "archive destination changed before rotation; the original was preserved",
            )
          await beforeWrite()
          await writeFileAtomic(join(root, mediaManifestName(entry)), JSON.stringify(receipt), {
            beforePublish: beforeWrite,
            signal: options.signal,
          })
          await removeLocalCopy(root, receipt, beforeWrite, options.signal)
          moved++
          movedBytes += entry.size
        }
      return {
        directory: root,
        archiveDirectory: target,
        beforeTime: new Date(cutoff).toISOString(),
        selected,
        selectedBytes,
        moved,
        movedBytes,
        alreadyArchived,
        undated,
        complete: undated === 0,
        dryRun: options.dryRun === true,
      }
    },
    { additional: [target], createAdditional: !options.dryRun },
  )
}
