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
): WriterLease => {
  let releasing: Promise<void> | undefined
  const release = async () => {
    if (!(await sameOrdinaryFile(path, identity)))
      throw new CliError("configuration_error", "owned archive lock changed before release")
    const current = await readLeaseOwner(path, name)
    if (!current || current.host !== owner.host || current.pid !== owner.pid || current.nonce !== owner.nonce)
      throw new CliError("configuration_error", "owned archive lock changed before release")
    await unlink(path)
    await rmdir(folder).catch(() => undefined)
  }
  return {
    release: () =>
      (releasing ??= release().catch((error) => {
        releasing = undefined
        throw error
      })),
  }
}

import type { BigIntStats } from "node:fs"
