import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore, storedTemplateBodies } from "./store.js"

it("gives an older file the empty template tables, which the delivery path reads as no templates before it", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-59-")), "wirecat.db")
  await (await openStore({ path })).close()

  const old = await openCache(path)
  rollBackTo(old, 59)
  expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'templates'").get()).toBeUndefined()
  expect(storedTemplateBodies(old, "report/morning-digest", "ru")).toEqual({})
  old.close()

  const upgraded = await openStore({ path })
  const address = { key: "report/morning-digest", channel: "text", language: "ru" }
  upgraded.templates.save(address, "one", "fixture")
  upgraded.templates.save(address, "two", "fixture")
  expect(upgraded.templates.reset(address)).toBe(true)
  expect(upgraded.templates.reset(address)).toBe(false)
  expect(upgraded.templates.get(address)).toBeUndefined()
  expect(upgraded.templates.history(address).map((entry) => entry.body)).toEqual(["two", "one"])
  await upgraded.close()
})
