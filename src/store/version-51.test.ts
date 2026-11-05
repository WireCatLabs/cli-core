import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("adds task and order links to a version 50 file, and a task keeps, changes and clears them", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-51-")), "wirecat.db")
  const store = await openStore({ path })
  const project = await store.knowledge.addProject({ name: "Café sale" })
  const before = await store.tasks.create({ project: project.ref, title: "Call the buyer", type: "chore" }, "owner")
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 51)
  expect(old.prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'source_url'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  try {
    expect(await upgraded.tasks.details(before.id)).toMatchObject({ externalId: null, sourceUrl: null })
    const task = await upgraded.tasks.create(
      {
        project: project.ref,
        title: "Reply on Avito to Ivan",
        type: "chore",
        externalId: "avito:4512345678",
        sourceUrl: "https://www.avito.ru/moskva/gotoviy_biznes/kafe_4512345678",
      },
      "owner",
    )
    expect(task).toMatchObject({
      externalId: "avito:4512345678",
      sourceUrl: "https://www.avito.ru/moskva/gotoviy_biznes/kafe_4512345678",
    })
    expect(await upgraded.tasks.edit(task.id, { externalId: "cian:301", sourceUrl: null }, "owner")).toMatchObject({
      externalId: "cian:301",
      sourceUrl: null,
    })
    await expect(upgraded.tasks.edit(task.id, { sourceUrl: "ftp://example.com/x" }, "owner")).rejects.toMatchObject({
      details: { reason: "task.source-url" },
    })
    await expect(upgraded.tasks.edit(task.id, { externalId: "no-service" }, "owner")).rejects.toMatchObject({
      details: { reason: "task.external-id" },
    })
    expect(await upgraded.tasks.edit(task.id, { externalId: null }, "owner")).toMatchObject({ externalId: null })
  } finally {
    await upgraded.close()
  }
})
