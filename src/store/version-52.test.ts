import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("adds pipelines, deals, leads and the default lead pipeline to a version 51 file", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-52-")), "wirecat.db")
  const store = await openStore({ path })
  const client = await store.knowledge.addOrganization({ kind: "company", name: "Client One" })
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 52)
  expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'deals'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  try {
    expect((await upgraded.deals.pipelines()).map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "Leads", kind: "lead" },
    ])
    await upgraded.deals.addPipeline({ name: "Sales", stages: ["Lead"], by: "owner" })
    const deal = await upgraded.deals.add({ by: "owner", title: "Site", stage: "Lead", organization: client.ref })
    expect(deal).toMatchObject({ status: "open", organization: { name: "Client One" } })
  } finally {
    await upgraded.close()
  }
})

it("keeps a CRM account's pipelines apart, and refuses a deal in a lead pipeline's stage", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-52-")), "wirecat.db")
  const store = await openStore({ path })
  await store.close()
  const db = await openCache(path)
  try {
    db.prepare("INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('b24', 'a', 0, 0)").run()
    db.prepare("INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('b24', 'b', 0, 0)").run()
    const insert = db.prepare(
      "INSERT INTO pipelines (account_id, external_id, kind, name, name_folded, created_at, updated_at) " +
        "VALUES (?, '1', 'deal', 'Sales', 'sales', 0, 0)",
    )
    insert.run(1)
    insert.run(2)
    expect(() => insert.run(1)).toThrow()
    const lead = db
      .prepare("SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE p.kind = 'lead'")
      .get()
    expect(() =>
      db
        .prepare(
          "INSERT INTO deals (title, stage_id, status, author_type, author_id, source, created_at, updated_at) " +
            "VALUES ('x', ?, 'open', 'person', 1, 'owner', 0, 0)",
        )
        .run(Number(lead?.id)),
    ).toThrow(/stage of a deal pipeline/)
  } finally {
    db.close()
  }
})
