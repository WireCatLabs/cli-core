import { lstat, readdir, realpath, unlink } from "node:fs/promises"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { leaseOwnerStatus, missingLeaseFile, readLeaseOwner } from "./native-lease-owner.js"
import type { WriterLeaseInfo, WriterLeaseStore } from "./writer-lease.js"

export const leaseInspection = (markerDirectory: string): Pick<WriterLeaseStore, "inspect" | "recover"> => {
  const inspect: WriterLeaseStore["inspect"] = async (destination, options = {}) => {
    options.signal?.throwIfAborted()
    const root = await realpath(destination)
    options.signal?.throwIfAborted()
    const folder = join(root, markerDirectory)
    let names: string[]
    try {
      if ((await lstat(folder)).isSymbolicLink()) throw new Error("symlink")
      names = await readdir(folder)
    } catch (error) {
      options.signal?.throwIfAborted()
      if (missingLeaseFile(error)) return []
      throw new CliError("configuration_error", "archive lock directory could not be read")
    }
    options.signal?.throwIfAborted()
    const result: WriterLeaseInfo[] = []
    for (const name of names.sort()) {
      options.signal?.throwIfAborted()
      const owner = await readLeaseOwner(join(folder, name), name, options.signal)
      result.push({
        name,
        status: owner ? leaseOwnerStatus(owner) : "unrecognized",
        pid: owner?.pid ?? null,
        host: owner?.host ?? null,
      })
    }
    return result
  }
  const recover: WriterLeaseStore["recover"] = async (destination, options = {}) => {
    options.signal?.throwIfAborted()
    const root = await realpath(destination)
    const locks = await inspect(root, options)
    const removed: string[] = []
    if (options.apply)
      for (const lock of locks) {
        options.signal?.throwIfAborted()
        if (lock.status !== "stale") continue
        const path = join(root, markerDirectory, lock.name)
        const owner = await readLeaseOwner(path, lock.name, options.signal)
        if (!owner || leaseOwnerStatus(owner) !== "stale") continue
        try {
          await unlink(path)
          removed.push(lock.name)
        } catch (error) {
          if (!missingLeaseFile(error))
            throw new CliError("configuration_error", "stale archive lock could not be removed")
        }
      }
    return { locks, removed }
  }
  return { inspect, recover }
}
