import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const PORTAL = { provider: "example-crm", account: "acme.example" }

it("adds base stages to a version 59 file's CRM pipelines, unmapped, and suggests them on first use", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-60-")), "wirecat.db")
  const seeded = await openStore({ path })
  await seeded.crm.savePipelines(PORTAL, "deal", [
    {
      externalId: "p1",
      name: "Sales",
      stages: [
        { externalId: "s1", name: "New", position: 1, outcome: "open" },
        { externalId: "s2", name: "Won", position: 2, outcome: "won" },
      ],
    },
  ])
  await seeded.crm.saveItems(PORTAL, "deal", [{ externalId: "d1", title: "Acme renewal", pipeline: "p1", stage: "s1" }])
  await seeded.close()
  const old = await openCache(path)
  rollBackTo(old, 60)
  expect(old.prepare("SELECT name FROM pragma_table_info('pipeline_stages') WHERE name LIKE 'base%'").all()).toEqual([])
  old.close()

  const store = await openStore({ path })
  try {
    expect(await store.baseStages.mappings()).toMatchObject([
      { name: "New", baseStage: null, confirmed: false },
      { name: "Won", baseStage: null, confirmed: false },
    ])
    expect((await store.deals.list())[0]).toMatchObject({ title: "Acme renewal", stage: "New", baseStage: null })
    const base = await store.baseStages.show("deal")
    expect(base.unsorted).toEqual({ open: 1, stages: 2 })
    expect(await store.baseStages.mappings()).toMatchObject([
      { name: "New", baseStage: { name: "Новая" }, confirmed: false },
      { name: "Won", baseStage: { name: "Выиграна" }, confirmed: false },
    ])
  } finally {
    await store.close()
  }
})
