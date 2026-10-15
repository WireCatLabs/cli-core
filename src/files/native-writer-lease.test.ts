import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { nativeWriterLeaseStore } from "./index.js"

const layout = { markerDirectory: ".calendar-writers", legacyMarker: ".calendar-legacy" }
const store = nativeWriterLeaseStore(layout)
const root = () => mkdtemp(join(tmpdir(), "core-test-writer-lease-"))
const marker = async (destination: string, pid: number, host = hostname()) => {
  const owner = { version: 1, pid, host, nonce: randomUUID() }
  const name = `${pid}-${owner.nonce}.json`
  await mkdir(join(destination, layout.markerDirectory), { recursive: true })
  await writeFile(join(destination, layout.markerDirectory, name), JSON.stringify(owner))
  return name
}

it("exposes a provider-neutral owned release, serializes a physical root and releases after cancellation", async () => {
  const destination = await root()
  const controller = new AbortController()
  const held = await store.acquire(destination, { signal: controller.signal })
  expect(held.status).toBe("acquired")
  if (held.status !== "acquired") throw new Error("lease missing")
  expect(await store.inspect(destination)).toMatchObject([{ status: "active", pid: process.pid }])
  const blocked = await nativeWriterLeaseStore(layout).acquire(destination)
  expect(blocked).toMatchObject({ status: "busy", locks: [{ status: "active", pid: process.pid }] })
  expect(await readdir(join(destination, layout.markerDirectory))).toHaveLength(1)
  controller.abort()
  await Promise.all([held.lease.release(), held.lease.release()])
  await held.lease.release()
  expect(await store.inspect(destination)).toEqual([])
  const next = await store.acquire(destination)
  if (next.status !== "acquired") throw new Error("lease not released")
  await next.lease.release()
})

it("previews without writes and recovers only dead local owners, preserving active, foreign and malformed entries", async () => {
  const destination = await root()
  expect(await store.recover(destination)).toEqual({ locks: [], removed: [] })
  expect(await readdir(destination)).toEqual([])
  const dead = 2147483647
  const stale = await marker(destination, dead)
  const active = await marker(destination, process.pid)
  const foreign = await marker(destination, dead, "example-other-host")
  const folder = join(destination, layout.markerDirectory)
  await writeFile(join(folder, "unknown.json"), "unrecognized example")
  await writeFile(join(folder, "oversized.json"), "x".repeat(4097))
  await writeFile(join(folder, "null.json"), "null")
  const before = await readdir(folder)
  const preview = await store.recover(destination)
  expect(preview.removed).toEqual([])
  expect(preview.locks.map((lock) => lock.status).sort()).toEqual([
    "active",
    "foreign",
    "stale",
    "unrecognized",
    "unrecognized",
    "unrecognized",
  ])
  expect(await readdir(folder)).toEqual(before)
  expect((await store.recover(destination, { apply: true })).removed).toEqual([stale])
  expect((await readdir(folder)).sort()).toEqual(
    [active, foreign, "unknown.json", "oversized.json", "null.json"].sort(),
  )
})

it("rechecks a previously dead owner before recovery removes its marker", async () => {
  const destination = await root()
  const pid = 2147483647
  const name = await marker(destination, pid)
  let probes = 0
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    if (++probes === 1) throw Object.assign(new Error("dead"), { code: "ESRCH" })
    return true
  })
  try {
    expect((await store.recover(destination, { apply: true })).removed).toEqual([])
    expect(await readFile(join(destination, layout.markerDirectory, name), "utf8")).toContain(String(pid))
  } finally {
    kill.mockRestore()
  }
})

it("treats permission-denied process probes as active and refuses legacy markers without leaking its own marker", async () => {
  const destination = await root()
  await marker(destination, 2147483647)
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EPERM" })
  })
  try {
    expect((await store.inspect(destination))[0]?.status).toBe("active")
  } finally {
    kill.mockRestore()
  }
  const legacy = await root()
  await writeFile(join(legacy, layout.legacyMarker), "example legacy owner")
  expect(await store.acquire(legacy)).toEqual({ status: "legacy" })
  expect(await store.inspect(legacy)).toEqual([])
  expect(await readFile(join(legacy, layout.legacyMarker), "utf8")).toBe("example legacy owner")
})

it("cleans only its new marker when cancelled after durable creation, and never creates one for pre-cancellation", async () => {
  const destination = await root()
  const controller = new AbortController()
  const original = controller.signal.throwIfAborted.bind(controller.signal)
  const check = vi.spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
    const folder = join(destination, layout.markerDirectory)
    if (existsSync(folder) && readdirSync(folder).length) controller.abort()
    original()
  })
  try {
    await expect(store.acquire(destination, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
  } finally {
    check.mockRestore()
  }
  expect(await store.inspect(destination)).toEqual([])
  const empty = await root()
  await expect(store.acquire(empty, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
  expect(await readdir(empty)).toEqual([])
})

it("preserves an externally replaced owner record rather than unlinking it during release", async () => {
  const destination = await root()
  const held = await store.acquire(destination)
  if (held.status !== "acquired") throw new Error("lease missing")
  const [name] = await readdir(join(destination, layout.markerDirectory))
  if (!name) throw new Error("owner marker missing")
  const path = join(destination, layout.markerDirectory, name)
  await writeFile(path, "example replacement owner")
  await expect(held.lease.release()).rejects.toMatchObject({ code: "configuration_error" })
  expect(await readFile(path, "utf8")).toBe("example replacement owner")
})

it("does not grant ownership if its marker disappears before confirmation", async () => {
  const destination = await root()
  const controller = new AbortController()
  const folder = join(destination, layout.markerDirectory)
  let removed = false
  const check = vi.spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
    if (!removed && existsSync(folder)) {
      const [name] = readdirSync(folder)
      if (name) {
        unlinkSync(join(folder, name))
        removed = true
      }
    }
  })
  try {
    await expect(store.acquire(destination, { signal: controller.signal })).rejects.toMatchObject({
      code: "configuration_error",
    })
  } finally {
    check.mockRestore()
  }
  expect(removed).toBe(true)
  expect(await store.inspect(destination)).toEqual([])
})

it("preserves a replacement marker when ownership confirmation fails", async () => {
  const destination = await root()
  const controller = new AbortController()
  const folder = join(destination, layout.markerDirectory)
  let replaced = false
  let replacement = ""
  const check = vi.spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
    if (!replaced && existsSync(folder)) {
      const [name] = readdirSync(folder)
      if (name) {
        replacement = join(folder, name)
        renameSync(replacement, join(destination, "original-marker"))
        writeFileSync(replacement, "example replacement record")
        replaced = true
      }
    }
  })
  try {
    await expect(store.acquire(destination, { signal: controller.signal })).rejects.toMatchObject({
      code: "configuration_error",
    })
  } finally {
    check.mockRestore()
  }
  expect(replaced).toBe(true)
  expect(await readFile(replacement, "utf8")).toBe("example replacement record")
})

it("rejects unsafe layouts and a symlinked marker directory without touching its target", async () => {
  for (const markerDirectory of ["", ".", "..", "../escape", "C:escape", "a/b", "a\\b", "/absolute", "bad\0name"])
    expect(() => nativeWriterLeaseStore({ markerDirectory })).toThrow()
  expect(() => nativeWriterLeaseStore({ markerDirectory: "same", legacyMarker: "same" })).toThrow()
  const destination = await root()
  const outside = await root()
  await writeFile(join(outside, "sentinel"), "example foreign file")
  await symlink(outside, join(destination, layout.markerDirectory), "junction")
  await expect(store.acquire(destination)).rejects.toMatchObject({ code: "validation_error" })
  await expect(store.inspect(destination)).rejects.toMatchObject({ code: "configuration_error" })
  expect(await readdir(outside)).toEqual(["sentinel"])
})
