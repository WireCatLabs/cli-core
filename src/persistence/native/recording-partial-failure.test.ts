import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { NativeRecordingPartialStore } from "./index.js"

const fault = vi.hoisted(() => ({
  root: "",
  race: "",
  shortIO: false,
  zeroWrite: false,
  truncate: false,
  metadata: false,
  close: false,
  afterSync: undefined as ((path: string) => void) | undefined,
  opened: 0,
  closed: 0,
  abort: undefined as (() => void) | undefined,
}))
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === fault.race && typeof args[1] === "number" && (args[1] & constants.O_RDWR) !== 0) {
        fault.race = ""
        await fs.rename(String(args[0]), `${args[0]}.original`)
        await fs.writeFile(String(args[0]), "abc")
      }
      const file = await fs.open(...args)
      if (typeof args[0] !== "string" || !fault.root || !args[0].startsWith(fault.root)) return file
      const path = args[0]
      fault.opened++
      fault.abort?.()
      return new Proxy(file, {
        get(target, key) {
          if (key === "close")
            return async () => {
              fault.closed++
              await target.close()
              if (fault.close && path !== fault.root) throw new Error("example late close failure")
            }
          if (key === "read")
            return async (buffer: Buffer, offset: number, length: number, position: number) =>
              target.read(buffer, offset, fault.shortIO ? Math.min(2, length) : length, position)
          if (key === "write")
            return async (buffer: Buffer, offset: number, length: number, position: number) => {
              if (fault.zeroWrite) return { bytesWritten: 0, buffer }
              return target.write(buffer, offset, fault.shortIO ? Math.min(2, length) : length, position)
            }
          if (key === "sync")
            return async () => {
              await target.sync()
              fault.afterSync?.(path)
            }
          if (key === "truncate")
            return async (length: number) => {
              if (fault.truncate) throw new Error("example truncate failure")
              return target.truncate(length)
            }
          if (key === "writeFile")
            return async (content: string) => {
              if (fault.metadata && path.endsWith(".tmp")) throw new Error("example metadata write failure")
              return target.writeFile(content)
            }
          const value: unknown = Reflect.get(target, key, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    },
  }
})
const locator = { provider: "sample-calls", account: "bob", occurrenceId: "weekly", assetId: "audio" }
const options = { prefix: ".sample-partial-", persistent: true, maxBytes: 100 }
const store = async (signal?: AbortSignal, persistent = true) => {
  fault.root = await mkdtemp(join(tmpdir(), "cli-messaging-test-partial-fault-"))
  fault.opened = 0
  fault.closed = 0
  return new NativeRecordingPartialStore(fault.root, locator, { ...options, persistent, signal })
}
afterEach(() => {
  fault.root = ""
  fault.race = ""
  fault.shortIO = false
  fault.zeroWrite = false
  fault.truncate = false
  fault.metadata = false
  fault.close = false
  fault.afterSync = undefined
  fault.abort = undefined
})

it("handles short metadata/prefix reads and short data writes without losing bytes or hashes", async () => {
  const s = await store()
  fault.shortIO = true
  const writer = await s.open(locator, { validator: '"v1"', total: 6 })
  try {
    await writer.write(Buffer.from("abcdef"))
    await writer.finish()
  } finally {
    await writer.close()
  }
  expect(await s.load(locator)).toMatchObject({ offset: 6, sha256: s.completed?.sha256 })
  expect(await readFile(s.path, "utf8")).toBe("abcdef")
  expect(fault.closed).toBe(fault.opened)
})

it("poisons an unsuccessful writer rather than checkpointing a false receipt", async () => {
  const s = await store()
  const writer = await s.open(locator, { validator: '"v1"', total: 6 })
  try {
    fault.zeroWrite = true
    await expect(writer.write(Buffer.from("abcdef"))).rejects.toThrow("did not progress")
    fault.zeroWrite = false
    await expect(writer.finish()).rejects.toThrow("no longer writable")
    expect(s.completed).toBeNull()
  } finally {
    await writer.close()
  }
  expect(fault.closed).toBe(fault.opened)
})

it("closes a resumed handle when truncation of excess trailing bytes fails", async () => {
  const s = await store()
  const writer = await s.open(locator, { validator: '"v1"', total: 6 })
  try {
    await writer.write(Buffer.from("abc"))
    await writer.checkpoint()
  } finally {
    await writer.close()
  }
  const partial = await s.load(locator)
  const { appendFile } = await import("node:fs/promises")
  await appendFile(s.path, "uncommitted")
  fault.truncate = true
  await expect(s.open(locator, { resume: partial ?? undefined, validator: '"v1"', total: 6 })).rejects.toThrow(
    "truncate failure",
  )
  expect(fault.closed).toBe(fault.opened)
  expect(s.completed).toBeNull()
})

it("closes a handle acquired immediately before cancellation and creates no checkpoint", async () => {
  const controller = new AbortController()
  const s = await store(controller.signal)
  fault.abort = () => controller.abort(new Error("example cancelled during open"))
  await expect(s.open(locator, { validator: '"v1"', total: 6 })).rejects.toThrow("cancelled during open")
  fault.abort = undefined
  expect(fault.closed).toBe(fault.opened)
  expect((await readdir(fault.root)).filter((name) => name.endsWith(".json") || name.endsWith(".tmp"))).toEqual([])
  expect(s.completed).toBeNull()
})

it("retains the previous checkpoint and removes temporary metadata after a durability failure", async () => {
  const s = await store()
  const writer = await s.open(locator, { validator: '"v1"', total: 6 })
  try {
    await writer.write(Buffer.from("abc"))
    await writer.checkpoint()
    await writer.write(Buffer.from("def"))
    fault.metadata = true
    await expect(writer.finish()).rejects.toThrow("metadata write failure")
    expect(s.completed).toBeNull()
  } finally {
    await writer.close()
  }
  fault.metadata = false
  expect(await s.load(locator)).toMatchObject({ offset: 3 })
  expect((await readdir(fault.root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  expect(fault.closed).toBe(fault.opened)
})

it("propagates late-close failure and withdraws the completion marker", async () => {
  const s = await store()
  const writer = await s.open(locator, { validator: '"v1"', total: 6 })
  await writer.write(Buffer.from("abcdef"))
  await writer.finish()
  expect(s.completed?.offset).toBe(6)
  fault.close = true
  await expect(writer.close()).rejects.toThrow("late close failure")
  expect(s.completed).toBeNull()
  expect(fault.closed).toBe(fault.opened)
})

it.each([false, true])(
  "refuses completion when cancellation arrives during final sync (persistent: %s)",
  async (persistent) => {
    if (persistent && process.platform === "win32") return
    const controller = new AbortController()
    const initial = await store(controller.signal)
    const s = new NativeRecordingPartialStore(fault.root, locator, {
      ...options,
      persistent,
      signal: controller.signal,
    })
    expect(initial.completed).toBeNull()
    const writer = await s.open(locator, { validator: '"v1"', total: 3 })
    try {
      await writer.write(Buffer.from("abc"))
      fault.afterSync = (path) => {
        if (!persistent || path === fault.root) controller.abort(new Error("example cancelled during final sync"))
      }
      await expect(writer.finish()).rejects.toThrow("cancelled during final sync")
      expect(s.completed).toBeNull()
    } finally {
      await writer.close()
    }
    expect(fault.closed).toBe(fault.opened)
  },
)

it("closes a failed fresh handle and preserves a foreign directory", async () => {
  const s = await store()
  await mkdir(s.path)
  await expect(s.open(locator, { validator: '"v1"', total: 3 })).rejects.toThrow()
  expect(await readdir(fault.root)).toEqual([s.path.split(/[\\/]/).at(-1)])
  expect(fault.opened).toBe(1)
  expect(fault.closed).toBe(1)
})

it("bounds serialized host metadata and closes its writer without a checkpoint", async () => {
  await store()
  const scope = { ...locator, account: "alice".repeat(4000) }
  const s = new NativeRecordingPartialStore(fault.root, scope, options)
  const writer = await s.open(scope, { validator: '"v1"', total: 3 })
  try {
    await writer.write(Buffer.from("abc"))
    await expect(writer.finish()).rejects.toThrow("metadata exceeds")
    expect(s.completed).toBeNull()
  } finally {
    await writer.close()
  }
  expect(fault.closed).toBe(fault.opened)
  expect(await s.load(scope)).toBeNull()
})

it("refuses a same-content replacement between verification and writable open", async () => {
  const s = await store()
  const seed = await s.open(locator, { validator: '"v1"', total: 6 })
  try {
    await seed.write(Buffer.from("abc"))
    await seed.checkpoint()
  } finally {
    await seed.close()
  }
  const partial = await s.load(locator)
  fault.race = s.path
  await expect(s.open(locator, { resume: partial ?? undefined, validator: '"v1"', total: 6 })).rejects.toThrow(
    "changed while opening",
  )
  expect(fault.race).toBe("")
  expect(fault.closed).toBe(fault.opened)
  expect(await readFile(s.path, "utf8")).toBe("abc")
})
