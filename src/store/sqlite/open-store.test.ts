import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { expect, it } from "vitest"
import { openStoreContext } from "./open-store.js"

const asRoot = process.getuid?.() === 0

it.skipIf(asRoot)("reports a store it may not write as a permission error that names no path", async () => {
  const folder = mkdtempSync(join(tmpdir(), "store-not-writable-")),
    file = join(folder, "wirecat.db")
  writeFileSync(file, "")
  chmodSync(file, 0o400)
  const failure = await openStoreContext({ path: file }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(CliError)
  expect(failure).toMatchObject({ code: "permission_error", details: { reason: "store.not-writable" } })
  expect((failure as Error).message).not.toContain(folder)
})

it.skipIf(asRoot)("reports a folder it may not create the store in the same way", async () => {
  const folder = join(mkdtempSync(join(tmpdir(), "store-not-writable-")), "locked")
  mkdirSync(folder, { mode: 0o500 })
  await expect(openStoreContext({ path: join(folder, "wirecat.db") })).rejects.toMatchObject({
    code: "permission_error",
    details: { reason: "store.not-writable" },
  })
})

/** The POSIX locks this process holds on the file, as the kernel lists them. */
const locksOn = (file: string) => {
  const { ino } = statSync(file)
  return readFileSync("/proc/locks", "utf8")
    .split("\n")
    .filter((line) => line.includes(` ${process.pid} `) && line.includes(`:${ino} `)).length
}

// Closing any descriptor of a file drops every lock the process holds on it; a second open must not close one.
it.skipIf(process.platform !== "linux")(
  "keeps the first connection's locks when the store is opened again",
  async () => {
    const file = join(mkdtempSync(join(tmpdir(), "store-locks-")), "wirecat.db")
    const first = await openStoreContext({ path: file })
    first.database.exec("BEGIN IMMEDIATE")
    const held = locksOn(file)
    expect(held).toBeGreaterThan(0)
    const second = await openStoreContext({ path: file }).catch((error: unknown) => error)
    expect(locksOn(file)).toBe(held)
    first.database.exec("ROLLBACK")
    first.database.close()
    if (!(second instanceof Error)) second.database.close()
  },
)
