import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const PORTAL = { provider: "example-crm", account: "portal" }
const SALES = {
  externalId: "p1",
  name: "Sales",
  stages: [
    { externalId: "s1", name: "New", position: 1, outcome: "open" as const },
    { externalId: "s2", name: "Won", position: 2, outcome: "won" as const },
  ],
}

it("lets a version 52 file's CRM account hold a deal and a lead pipeline with one id, and marks what the CRM dropped", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-53-")), "wirecat.db")
  const store = await openStore({ path })
  await store.crm.savePipelines(PORTAL, "deal", [SALES])
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 53)
  expect(old.prepare("SELECT 1 FROM pragma_table_info('pipelines') WHERE name = 'deleted_at'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  try {
    expect(await upgraded.crm.savePipelines(PORTAL, "lead", [{ ...SALES, name: "Leads" }])).toEqual({
      saved: 1,
      skipped: [],
    })
    await upgraded.crm.savePipelines(PORTAL, "deal", [{ ...SALES, stages: SALES.stages.slice(1) }])
  } finally {
    await upgraded.close()
  }
  const db = await openCache(path)
  try {
    const stages = db
      .prepare(
        "SELECT s.external_id, s.deleted_at FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id " +
          "WHERE p.kind = 'deal' AND p.account_id IS NOT NULL ORDER BY s.id",
      )
      .all() as { external_id: string; deleted_at: number | null }[]
    expect(stages.map(({ external_id, deleted_at }) => [external_id, deleted_at !== null])).toEqual([
      ["s1", true],
      ["s2", false],
    ])
  } finally {
    db.close()
  }
})
