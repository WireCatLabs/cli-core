import { mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { nativeWriterLeaseStore } from "./index.js"

const hooks = vi.hoisted(() => ({ failWrite: false }))
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args)
      if (hooks.failWrite && args[1] === "wx") {
        const write = file.writeFile.bind(file)
        file.writeFile = async () => {
          await write("{")
          throw Object.assign(new Error("example interrupted marker write"), { code: "EIO" })
        }
      }
      return file
    },
  }
})

it("cleans its own incomplete marker after a failed write without requiring valid owner JSON", async () => {
  const destination = await mkdtemp(join(tmpdir(), "core-test-lease-failure-"))
  const store = nativeWriterLeaseStore({ markerDirectory: ".example-writers" })
  hooks.failWrite = true
  try {
    await expect(store.acquire(destination)).rejects.toMatchObject({ code: "EIO" })
  } finally {
    hooks.failWrite = false
  }
  expect(await readdir(destination)).toEqual([])
  const next = await store.acquire(destination)
  if (next.status !== "acquired") throw new Error("failed write leaked ownership")
  await next.lease.release()
})
