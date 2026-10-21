import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
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
