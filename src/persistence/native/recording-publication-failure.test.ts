import { createHash } from "node:crypto"
import { link, mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { NativeRecordingPublication } from "./index.js"

const fault = vi.hoisted(() => ({
  root: "",
  shortRead: false,
  write: false,
  close: false,
  sync: "",
  rename: false,
  beforeLink: undefined as ((source: string, target: string) => Promise<void>) | undefined,
  afterSync: undefined as ((path: string) => Promise<void>) | undefined,
  opened: 0,
  closed: 0,
}))
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>()
  return {
    ...fs,
    link: async (source: string, target: string) => {
      await fault.beforeLink?.(source, target)
      return fs.link(source, target)
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (fault.rename && String(args[0]).endsWith(".tmp")) throw new Error("example rename failure")
      return fs.rename(...args)
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args)
      if (!fault.root || !String(args[0]).startsWith(fault.root)) return file
      const path = String(args[0])
      fault.opened++
      return new Proxy(file, {
        get(target, key) {
          if (key === "close")
            return async () => {
              fault.closed++
              await target.close()
              if (fault.close && path.endsWith(".part") && typeof args[1] === "number" && (args[1] & 2) !== 0)
                throw new Error("example late close failure")
            }
          if (key === "sync")
            return async () => {
              if (fault.sync === path) throw new Error("example sync failure")
              await target.sync()
              await fault.afterSync?.(path)
            }
          if (key === "writeFile")
            return async (content: string) => {
              if (fault.write) throw new Error("example journal write failure")
              return target.writeFile(content)
            }
          if (key === "read")
            return (buffer: Buffer, offset: number, length: number, position: number) =>
              target.read(buffer, offset, fault.shortRead ? Math.min(2, length) : length, position)
          const value: unknown = Reflect.get(target, key, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    },
  }
})
const locator = { provider: "example-calls", account: "alice", occurrenceId: "weekly", assetId: "audio" }
const sha256 = createHash("sha256").update("abcdef").digest("hex")
const evidence = { size: 6, sha256, validator: '"v1"' }
const checkpoint = { locator, offset: 6, sha256, validator: '"v1"', total: 6 }
const setup = async (signal?: AbortSignal) => {
  fault.root = await mkdtemp(join(tmpdir(), "cli-messaging-test-publication-fault-"))
  fault.opened = 0
  fault.closed = 0
  const publication = new NativeRecordingPublication(fault.root, locator, {
    prefix: ".example-intent-",
    filename: "audio.bin",
    maxBytes: 100,
    metadataLimit: 1024,
    codec: { encode: JSON.stringify, decode: (value) => value as typeof evidence },
    evidence: (value) => value,
    signal,
  })
  const partial = join(fault.root, "owned.part")
  await writeFile(partial, "abcdef")
  return { publication, partial }
}
afterEach(() => {
  fault.root = ""
  fault.shortRead = false
  fault.write = false
  fault.close = false
  fault.sync = ""
  fault.rename = false
  fault.beforeLink = undefined
  fault.afterSync = undefined
})

it("handles short journal and file reads", async () => {
  const { publication, partial } = await setup()
  fault.shortRead = true
  await publication.write(evidence)
  expect(await publication.read()).toEqual(evidence)
  await publication.publish(partial, evidence, async () => {})
  expect(fault.opened).toBe(fault.closed)
})

it.each(["write", "rename"] as const)("does not link or leak handles after journal %s failure", async (operation) => {
  const { publication } = await setup()
  fault[operation] = true
  await expect(publication.write(evidence)).rejects.toThrow("failure")
  await expect(readFile(publication.finalPath)).rejects.toMatchObject({ code: "ENOENT" })
  expect(fault.opened).toBe(fault.closed)
})

it("stops before linking when data sync fails", async () => {
  const { publication, partial } = await setup()
  fault.sync = partial
  const commit = vi.fn(async () => {})
  await expect(publication.publish(partial, evidence, commit)).rejects.toThrow("sync failure")
  expect(commit).not.toHaveBeenCalled()
  await expect(readFile(publication.finalPath)).rejects.toMatchObject({ code: "ENOENT" })
  expect(fault.opened).toBe(fault.closed)
})

it("does not acknowledge directory-sync failure, and permits verified recovery", async () => {
  const { publication, partial } = await setup()
  await publication.write(evidence)
  fault.sync = fault.root
  const commit = vi.fn(async () => {})
  await expect(publication.publish(partial, evidence, commit)).rejects.toThrow("sync failure")
  expect(commit).not.toHaveBeenCalled()
  expect(await readFile(partial, "utf8")).toBe("abcdef")
  fault.sync = ""
  await publication.recover(partial, async () => checkpoint, commit)
  expect(commit).toHaveBeenCalledOnce()
  expect(fault.opened).toBe(fault.closed)
})

it("preserves both paths and refuses commitment if a different file was linked", async () => {
  const { publication, partial } = await setup()
  const commit = vi.fn(async () => {})
  fault.beforeLink = async (source) => {
    await rename(source, `${source}.original`)
    await writeFile(source, "foreign")
  }
  await expect(publication.publish(partial, evidence, commit)).rejects.toThrow("path changed")
  expect(commit).not.toHaveBeenCalled()
  expect(await readFile(partial, "utf8")).toBe("foreign")
  expect(await readFile(`${partial}.original`, "utf8")).toBe("abcdef")
  expect(fault.opened).toBe(fault.closed)
})

it("does not remove a replacement partial after host commitment", async () => {
  const { publication, partial } = await setup()
  await expect(
    publication.publish(partial, evidence, async () => {
      await rename(partial, `${partial}.original`)
      await writeFile(partial, "foreign")
    }),
  ).rejects.toThrow("path changed")
  expect(await readFile(partial, "utf8")).toBe("foreign")
  expect(await readFile(publication.finalPath, "utf8")).toBe("abcdef")
  expect(fault.opened).toBe(fault.closed)
})

it("does not remove a replaced final or the original partial after commitment", async () => {
  const { publication, partial } = await setup()
  await expect(
    publication.publish(partial, evidence, async () => {
      await rename(publication.finalPath, `${publication.finalPath}.original`)
      await writeFile(publication.finalPath, "foreign")
    }),
  ).rejects.toThrow("path changed")
  expect(await readFile(publication.finalPath, "utf8")).toBe("foreign")
  expect(await readFile(partial, "utf8")).toBe("abcdef")
  expect(fault.opened).toBe(fault.closed)
})

it("retains ownership evidence after cancellation during journal directory sync", async () => {
  const controller = new AbortController()
  const { publication, partial } = await setup(controller.signal)
  fault.afterSync = async (path) => {
    if (path === fault.root) controller.abort(new Error("example cancel"))
  }
  await expect(publication.write(evidence)).rejects.toThrow("example cancel")
  expect(JSON.parse(await readFile(publication.journalPath, "utf8"))).toEqual(evidence)
  expect(await readFile(partial, "utf8")).toBe("abcdef")
  expect(fault.opened).toBe(fault.closed)
})

it("propagates late close failure rather than returning a successful receipt", async () => {
  const { publication, partial } = await setup()
  fault.close = true
  await expect(publication.publish(partial, evidence, async () => {})).rejects.toThrow("late close failure")
  expect(await readFile(publication.finalPath, "utf8")).toBe("abcdef")
  expect(fault.opened).toBe(fault.closed)
})

it("closes the acquired partial when recovery cannot open its final", async () => {
  const { publication, partial } = await setup()
  await publication.write(evidence)
  await expect(
    publication.recover(
      partial,
      async () => checkpoint,
      async () => {},
    ),
  ).rejects.toMatchObject({ code: "ENOENT" })
  expect(fault.opened).toBe(fault.closed)
})

it("can replay a journal persisted before the interrupted link", async () => {
  const { publication, partial } = await setup()
  await publication.write(evidence)
  await link(partial, publication.finalPath)
  await publication.recover(
    partial,
    async () => checkpoint,
    async () => {},
  )
  expect(fault.opened).toBe(fault.closed)
})

it("does not rename or remove a replacement journal temporary file", async () => {
  const { publication } = await setup()
  let replaced = ""
  fault.afterSync = async (path) => {
    if (!path.endsWith(".tmp")) return
    replaced = path
    await rename(path, `${path}.original`)
    await writeFile(path, "foreign")
  }
  await expect(publication.write(evidence)).rejects.toThrow("journal changed")
  expect(await readFile(replaced, "utf8")).toBe("foreign")
  expect(JSON.parse(await readFile(`${replaced}.original`, "utf8"))).toEqual(evidence)
  expect(fault.opened).toBe(fault.closed)
})

it("does not commit recovery when final-file sync fails", async () => {
  const { publication, partial } = await setup()
  await publication.write(evidence)
  await link(partial, publication.finalPath)
  fault.sync = publication.finalPath
  const commit = vi.fn(async () => {})
  await expect(publication.recover(partial, async () => checkpoint, commit)).rejects.toThrow("sync failure")
  expect(commit).not.toHaveBeenCalled()
  expect(await readFile(partial, "utf8")).toBe("abcdef")
  expect(fault.opened).toBe(fault.closed)
})
