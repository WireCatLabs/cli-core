import { mkdir, stat, statfs, unlink } from "node:fs/promises"
import { dirname, join, posix } from "node:path"
import { isCliError } from "@wirecat/cli-base"
import type { FileEntry, FileStepKind, RemoteFile } from "../../documents/file-mirror-model.js"
import type { LocalDocument } from "../../documents/push-model.js"
import { assertNoLink, hashFile, placeNew, scanLocal } from "../documents/push.js"
import type { FileVersions } from "./versions.js"

/** A local file as a mirror's scan finds it. */
export type Local = LocalDocument & { size: number; mtimeMs: number }

export const MAX_FILES = 100_000
export const TRASH = ".wirecat-trash"

/** What a run leaves free on a drive it writes to: a tenth of what it writes, from 100 MB up to 1 GB. */
export const spareFor = (needed: number) => Math.min(1024 ** 3, Math.max(100 * 1024 ** 2, needed / 10))

/** `name (conflict 2026-11-18 disk).ext`, numbered when that name is taken. */
export const copyName = (path: string, remote: string, date: string, taken: (path: string) => boolean) => {
  const extension = posix.extname(path)
  const stem = path.slice(0, path.length - extension.length)
  for (let n = 1; ; n++) {
    const candidate = `${stem} (conflict ${date} ${remote}${n > 1 ? ` ${n}` : ""})${extension}`
    if (!taken(candidate)) return candidate
  }
}

/** Moves a file into `<root>/.wirecat-trash/<date>/` while it still has `hash`; false when it changed. */
export const trashLocal = async (root: string, path: string, hash: string, date: string) => {
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
export const renameLocal = async (root: string, from: string, to: string, hash: string) => {
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

/** False when `path` or a folder on the way to it is a symbolic link, so nothing under it is touched. */
export const linkFree = (root: string, path: string) =>
  assertNoLink(root, path).then(
    () => true,
    (error: unknown) => {
      if (isCliError(error) && error.details?.reason === "mirror.symlink") return false
      throw error
    },
  )

/** True when the file at `absolute` is missing or has one of `hashes`: no partial copy is left there. */
export const whole = async (absolute: string, hashes: (string | undefined)[]) => {
  try {
    return hashes.includes((await hashFile(absolute)).sha256)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
  }
}

/** True when `path` is `link` or lies under it. */
export const under = (path: string, link: string) => path === link || path.startsWith(`${link}/`)

/** Free bytes and the device of the file system holding `path`, or of its nearest folder that exists. */
export const freeSpace = async (path: string): Promise<{ free: number; dev: number }> => {
  for (let at = path; ; at = dirname(at)) {
    try {
      const [{ bavail, bsize }, { dev }] = await Promise.all([statfs(at), stat(at)])
      return { free: bavail * bsize, dev }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) throw error
    }
  }
}

export const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

/**
 * The free space a run needs that a file system lacks: downloads land under `root`, and the store keeps every
 * content they replace or a deletion removes, plus each remote content an upload replaces that it lacks.
 */
export const shortOfSpace = async (
  steps: { kind: FileStepKind; local?: { size: number }; remote?: RemoteFile }[],
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
    if (step.kind === "merge") {
      incoming += local + remote
      kept += 2 * (local + remote)
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
  return needs.find((need) => need.needed > 0 && need.free < need.needed + spareFor(need.needed))
}

export const ancestors = (path: string) => {
  const found: string[] = []
  for (let up = posix.dirname(path); up !== "."; up = posix.dirname(up)) found.unshift(up)
  return found
}

/** Every local file but excluded ones, hashed only when its size or mtime moved since the last sync. */
export const scan = async (
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
