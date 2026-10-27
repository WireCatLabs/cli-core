import { join } from "node:path"
import { scratch } from "./scratch.ts"

export const checkFileLeases = async (dist: string): Promise<void> => {
  const { nativeWriterLeaseStore } = await import(join(dist, "files/index.js"))
  const destination = scratch("core-dist-writer-lease-")
  const leases = nativeWriterLeaseStore({ markerDirectory: ".example-provider-writers" })
  const controller = new AbortController()
  const held = await leases.acquire(destination, { signal: controller.signal })
  if (held.status !== "acquired") throw new Error("dist lease acquisition failed")
  try {
    const blocked = await leases.acquire(destination)
    if (blocked.status !== "busy" || blocked.locks.length !== 1 || blocked.locks[0].pid !== process.pid)
      throw new Error("dist lease did not exclude another writer")
  } finally {
    controller.abort()
    await Promise.all([held.lease.release(), held.lease.release()])
  }
  if ((await leases.inspect(destination)).length) throw new Error("dist lease cleanup failed after cancellation")
  const next = await leases.acquire(destination)
  if (next.status !== "acquired") throw new Error("dist lease remained locked")
  await next.lease.release()
  console.log("dist: ./files owns writer leases and releases after cancellation")
}
