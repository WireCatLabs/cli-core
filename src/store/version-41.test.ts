import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "version-41-")), "wirecat.db")

it("turns 0–4 priorities into scores, and keeps the score and revision in step with an older build's writes", async () => {
  const path = fresh()
  const store = await openStore({ path })
  await store.knowledge.addProject({ name: "Lighthouse", key: "LHT", type: "work" })
  for (const title of ["A", "B", "C"]) await store.tasks.create({ project: "LHT", title, type: "chore" }, "owner")
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 41)
  old.exec("UPDATE tasks SET priority = CASE key WHEN 'LHT-1' THEN 0 WHEN 'LHT-2' THEN 4 END")
  old.close()

  const upgraded = await openStore({ path })
  try {
    expect((await upgraded.tasks.details("LHT-1")).priority).toBe(0.875)
    expect(await upgraded.tasks.details("LHT-2")).toMatchObject({ priority: 0.0625, priorityLabel: "low" })
    expect(await upgraded.tasks.details("LHT-3")).toMatchObject({ priority: null, priorityLabel: null, revision: 1 })

    const database = await openCache(path)
    database.exec("UPDATE tasks SET priority = 1 WHERE key = 'LHT-3'")
    database.close()
    const synced = await upgraded.tasks.details("LHT-3")
    expect(synced).toMatchObject({ priority: 0.625, priorityLabel: "high" })
    expect(synced.revision).toBeGreaterThan(1)

    const edited = await upgraded.tasks.edit("LHT-3", { priority: 0.3 }, "owner")
    expect(edited).toMatchObject({ priority: 0.3, priorityLabel: "medium", revision: synced.revision + 1 })
    const check = await openCache(path)
    expect(check.prepare("SELECT priority FROM tasks WHERE key = 'LHT-3'").get()?.priority).toBe(2)
    check.close()
  } finally {
    await upgraded.close()
  }
})
