import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { acquireLock } from "./index.js"

const lockPath = async () => join(await mkdtemp(join(tmpdir(), "core-test-lock-")), "checkpoint.json.lock")

it("holds the lock until release, refuses a second holder and can be taken again", async () => {
  const path = await lockPath()
  const lock = await acquireLock(path)
  expect(await lock.held()).toBe(true)
  await expect(acquireLock(path)).rejects.toMatchObject({
    code: "validation_error",
    details: { reason: "file.locked", holders: [{ status: "active", pid: process.pid }] },
  })
  await lock.release()
  expect(await lock.held()).toBe(false)
  const again = await acquireLock(path)
  await again.release()
})

it("says the lock is no longer held when its marker was taken away", async () => {
  const path = await lockPath()
  const lock = await acquireLock(path)
  await rm(path, { recursive: true })
  expect(await lock.held()).toBe(false)
  await expect(lock.release()).rejects.toMatchObject({ code: "configuration_error" })
})

it("clears a lock left by a dead process on this machine, and keeps another machine's", async () => {
  const path = await lockPath()
  const leave = async (host: string) => {
    const owner = { version: 1, pid: 2147483647, host, nonce: randomUUID() }
    await mkdir(path, { recursive: true })
    await writeFile(join(path, `${owner.pid}-${owner.nonce}.json`), JSON.stringify(owner))
  }
  await leave(hostname())
  const lock = await acquireLock(path)
  expect(await readdir(path)).toHaveLength(1)
  await lock.release()
  await leave("example-other-host")
  await expect(acquireLock(path)).rejects.toMatchObject({ details: { holders: [{ status: "foreign" }] } })
})
