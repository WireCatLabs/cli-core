import { rmdir, unlink } from "node:fs/promises"
import { CliError } from "@wirecat/cli-base"
import { type NativeLeaseOwner, readLeaseOwner } from "./native-lease-owner.js"
import { sameOrdinaryFile } from "./ordinary-file.js"
import type { WriterLease } from "./writer-lease.js"

export const ownedNativeLease = (
  path: string,
  name: string,
  owner: NativeLeaseOwner,
  folder: string,
  identity: BigIntStats,
): WriterLease & { held(): Promise<boolean> } => {
  let releasing: Promise<void> | undefined
  const held = async () => {
    if (!(await sameOrdinaryFile(path, identity))) return false
    const current = await readLeaseOwner(path, name)
    return current?.host === owner.host && current.pid === owner.pid && current.nonce === owner.nonce
  }
  const release = async () => {
    if (!(await held())) throw new CliError("configuration_error", "owned archive lock changed before release")
    await unlink(path)
    await rmdir(folder).catch(() => undefined)
  }
  return {
    held,
    release: () =>
      (releasing ??= release().catch((error) => {
        releasing = undefined
        throw error
      })),
  }
}

import type { BigIntStats } from "node:fs"
