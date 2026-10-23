import { mkdir, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { acquireLock, type FileLock } from "../files/index.js"
import { missingMediaFile, readMediaManifests } from "./media-archive-manifest.js"

const archiveLocations = async (initial: readonly string[], signal?: AbortSignal) => {
  const roots = new Set<string>()
  const queued = new Set(initial.map((directory) => resolve(directory)))
  const pending = [...queued]
  for (let at = 0; at < pending.length; at++) {
    signal?.throwIfAborted()
    let root: string
    try {
      root = await realpath(pending[at] as string)
    } catch (error) {
      if (missingMediaFile(error)) continue
      throw error
    }
    if (roots.has(root)) continue
    if (roots.size >= 64) throw new CliError("validation_error", "too many linked media archive directories")
    roots.add(root)
    for (const entry of await readMediaManifests(root, signal))
      if (entry.relocatedTo) {
        const location = resolve(entry.relocatedTo)
        if (!queued.has(location)) {
          queued.add(location)
          pending.push(location)
        }
      }
  }
  return [...roots].sort()
}

/** Acquire in canonical path order, then recheck the graph before trusting relocation records. */
export const withMediaArchiveLocks = async <T>(
  directory: string,
  signal: AbortSignal | undefined,
  run: (root: string, beforeWrite: () => Promise<void>) => Promise<T>,
  options: { create?: boolean; additional?: readonly string[]; createAdditional?: boolean } = {},
): Promise<T> => {
  signal?.throwIfAborted()
  if (options.create) await mkdir(directory, { recursive: true, mode: 0o700 })
  const root = await realpath(directory)
  if (options.createAdditional)
    for (const other of options.additional ?? []) await mkdir(other, { recursive: true, mode: 0o700 })
  const initial = [root, ...(options.additional ?? [])]
  for (let attempt = 0; attempt < 3; attempt++) {
    const locations = await archiveLocations(initial, signal)
    const leases: FileLock[] = []
    try {
      for (const location of locations) leases.push(await acquireLock(join(location, ".media-writers"), { signal }))
      const current = await archiveLocations(initial, signal)
      if (current.some((location) => !locations.includes(location))) continue
      const beforeWrite = async () => {
        signal?.throwIfAborted()
        for (const lease of leases)
          if (!(await lease.held())) throw new CliError("validation_error", "media archive writer lost its lock")
      }
      await beforeWrite()
      return await run(root, beforeWrite)
    } finally {
      for (const lease of leases.reverse()) await lease.release()
    }
  }
  throw new CliError("validation_error", "archive locations changed during locking; run the command again")
}
