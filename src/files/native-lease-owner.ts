import { hostname } from "node:os"
import { openOrdinaryFile } from "./ordinary-file.js"
import type { WriterLeaseInfo } from "./writer-lease.js"

export interface NativeLeaseOwner {
  version: 1
  pid: number
  host: string
  nonce: string
}

export const missingLeaseFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

export const readLeaseOwner = async (
  path: string,
  name: string,
  signal?: AbortSignal,
): Promise<NativeLeaseOwner | null> => {
  signal?.throwIfAborted()
  try {
    const file = await openOrdinaryFile(path)
    try {
      if ((await file.stat()).size > 4096) return null
      const buffer = Buffer.alloc(4097)
      let size = 0
      while (size < buffer.length) {
        signal?.throwIfAborted()
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
        if (bytesRead === 0) break
        size += bytesRead
      }
      signal?.throwIfAborted()
      if (size > 4096) return null
      const owner = JSON.parse(buffer.subarray(0, size).toString("utf8")) as NativeLeaseOwner
      if (
        owner?.version !== 1 ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        typeof owner.host !== "string" ||
        !owner.host.trim() ||
        !/^[a-f0-9-]{36}$/.test(owner.nonce) ||
        name !== `${owner.pid}-${owner.nonce}.json`
      )
        return null
      return owner
    } finally {
      await file.close()
    }
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

export const leaseOwnerStatus = (owner: NativeLeaseOwner): WriterLeaseInfo["status"] => {
  if (owner.host !== hostname()) return "foreign"
  try {
    process.kill(owner.pid, 0)
    return "active"
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH" ? "stale" : "active"
  }
}
