import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("stops a claim from bumping a task's revision once a version 41 store upgrades", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-42-")), "wirecat.db")
  const store = await openStore({ path })
  await store.knowledge.addProject({ name: "Lighthouse", key: "LHT", type: "work" })
  await store.tasks.create({ project: "LHT", title: "A", type: "chore" }, "owner")
  await store.close()

  const revision = (database: Awaited<ReturnType<typeof openCache>>) =>
    database.prepare("SELECT revision FROM tasks WHERE key = 'LHT-1'").get()?.revision
  const old = await openCache(path)
  rollBackTo(old, 42)
  old.exec("UPDATE tasks SET claimed_by = 'hermes', claimed_until = 1 WHERE key = 'LHT-1'")
  expect(revision(old)).toBe(2)
  old.close()

  const upgraded = await openStore({ path })
  await upgraded.close()
  const database = await openCache(path)
  try {
    database.exec("UPDATE tasks SET claimed_by = 'hermes', claimed_until = 2 WHERE key = 'LHT-1'")
    expect(revision(database)).toBe(2)
    database.exec("UPDATE tasks SET title = 'B' WHERE key = 'LHT-1'")
    expect(revision(database)).toBe(3)
  } finally {
    database.close()
  }
})
