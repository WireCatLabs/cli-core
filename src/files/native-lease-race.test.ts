import { mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { nativeWriterLeaseStore } from "./index.js"

const hooks = vi.hoisted(() => ({ removeBeforeOpen: 0 }))
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (hooks.removeBeforeOpen > 0 && args[1] === "wx") {
        hooks.removeBeforeOpen -= 1
        await fs.rmdir(join(String(args[0]), ".."))
      }
      return fs.open(...args)
    },
  }
})

it("takes the lock when another writer removes the empty marker folder before its marker is written", async () => {
  const destination = await mkdtemp(join(tmpdir(), "core-test-lease-race-"))
  const store = nativeWriterLeaseStore({ markerDirectory: ".example-writers" })
  hooks.removeBeforeOpen = 2
  const acquired = await store.acquire(destination)
  expect(hooks.removeBeforeOpen).toBe(0)
  if (acquired.status !== "acquired") throw new Error("the vanished folder was not created again")
  await acquired.lease.release()
  expect(await readdir(destination)).toEqual([])
})
