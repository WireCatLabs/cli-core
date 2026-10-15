import { randomUUID } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { leaseInspection } from "./native-lease-inspection.js"
import { missingLeaseFile, type NativeLeaseOwner } from "./native-lease-owner.js"
import { ownedNativeLease } from "./native-lease-release.js"
import { sameOrdinaryFile } from "./ordinary-file.js"
import type { WriterLeaseStore } from "./writer-lease.js"

export interface NativeWriterLeaseLayout {
  markerDirectory: string
  legacyMarker?: string
}

const validName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && !/[\\/\0:]/.test(value)

/** Native PID/nonce markers; cooperating writers must use the same root and marker layout. */
export const nativeWriterLeaseStore = (layout: NativeWriterLeaseLayout): WriterLeaseStore => {
  const { markerDirectory, legacyMarker } = layout
  if (
    !validName(markerDirectory) ||
    (legacyMarker !== undefined && (!validName(legacyMarker) || legacyMarker === markerDirectory))
  )
    throw new CliError("validation_error", "archive lock layout requires distinct ordinary entry names")
  const inspection = leaseInspection(markerDirectory)
  return {
    ...inspection,
    acquire: async (destination, { signal } = {}) => {
      signal?.throwIfAborted()
      const root = await realpath(destination)
      signal?.throwIfAborted()
      const folder = join(root, markerDirectory)
      await mkdir(folder, { recursive: true })
      if ((await lstat(folder)).isSymbolicLink())
        throw new CliError("validation_error", "archive lock directory must not be a symlink")
      await inspection.recover(root, { apply: true, signal })
      signal?.throwIfAborted()
      const owner: NativeLeaseOwner = { version: 1, pid: process.pid, host: hostname(), nonce: randomUUID() }
      const name = `${owner.pid}-${owner.nonce}.json`
      const path = join(folder, name)
      const file = await open(path, "wx", 0o600)
      let retained = false
      let identity: BigIntStats | undefined
      try {
        identity = await file.stat({ bigint: true })
        await file.writeFile(JSON.stringify(owner))
        await file.sync()
        await file.close()
        signal?.throwIfAborted()
        const inspected = await inspection.inspect(root, { signal })
        const own = inspected.find((lock) => lock.name === name)
        if (own?.status !== "active" || own.pid !== owner.pid || own.host !== owner.host)
          throw new CliError("configuration_error", "archive writer lost its lock before acquisition")
        const locks = inspected.filter((lock) => lock.name !== name)
        if (locks.length) return { status: "busy", locks }
        if (legacyMarker) {
          try {
            await lstat(join(root, legacyMarker))
            return { status: "legacy" }
          } catch (error) {
            if (!missingLeaseFile(error)) throw error
          }
        }
        signal?.throwIfAborted()
        retained = true
        return { status: "acquired", lease: ownedNativeLease(path, name, owner, folder, identity) }
      } finally {
        await file.close().catch(() => undefined)
        if (!retained) {
          if (identity && (await sameOrdinaryFile(path, identity))) await unlink(path).catch(() => undefined)
          await rmdir(folder).catch(() => undefined)
        }
      }
    },
  }
}
