import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import { openCache } from "./open.js"

afterEach(() => {
  vi.restoreAllMocks()
})

it("closes the database when a file that is not a store fails to open", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "open-cache-")), "broken.db")
  writeFileSync(path, "not a sqlite database, long enough to fill the header page".repeat(4))
  const close = vi.spyOn(DatabaseSync.prototype, "close")

  await expect(openCache(path)).rejects.toThrow(/not a database/)
  expect(close).toHaveBeenCalledTimes(1)

  rmSync(path)
  const reopened = await openCache(path)
  expect(reopened.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
  reopened.close()
})
