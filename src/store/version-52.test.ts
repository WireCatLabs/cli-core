import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("adds pipelines and deals to a version 51 file and keeps what it held", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-52-")), "wirecat.db")
  const store = await openStore({ path })
  const client = await store.knowledge.addOrganization({ kind: "company", name: "Client One" })
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 52)
  expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'opportunities'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  try {
    await upgraded.deals.addPipeline({ name: "Sales", stages: ["Lead"], by: "owner" })
    const deal = await upgraded.deals.add({ by: "owner", title: "Site", stage: "Lead", organization: client.ref })
    expect(deal).toMatchObject({ status: "open", organization: { name: "Client One" } })
  } finally {
    await upgraded.close()
  }
})

it("keeps CRM pipelines per account, the owner's names per kind, and a deal out of a lead pipeline", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-52-")), "wirecat.db")
  await (await openStore({ path })).close()
  const db = await openCache(path)
  try {
    db.exec(
      "INSERT INTO accounts (id, provider, external_id, created_at, updated_at) VALUES " +
        "(1, 'bitrix24', 'one', 0, 0), (2, 'amocrm', 'two', 0, 0);" +
        "INSERT INTO pipelines (id, account_id, external_id, kind, name, name_folded, created_at, updated_at) VALUES " +
        "(1, 1, '0', 'deal', 'Sales', 'sales', 0, 0), (2, 2, '7', 'deal', 'Sales', 'sales', 0, 0), " +
        "(3, NULL, NULL, 'deal', 'Sales', 'sales', 0, 0), (4, NULL, NULL, 'lead', 'Sales', 'sales', 0, 0);" +
        "INSERT INTO pipeline_stages (id, pipeline_id, name, name_folded, position, outcome, external_id, created_at, " +
        "updated_at) VALUES (1, 1, 'New', 'new', 1, 'open', 'NEW', 0, 0), (2, 1, 'Won', 'won', 2, 'won', 'WON', 0, 0), " +
        "(3, 4, 'New', 'new', 1, 'open', NULL, 0, 0);",
    )
    const refused = (sql: string) => expect(() => db.exec(sql)).toThrow()
    refused(
      "INSERT INTO pipelines (account_id, kind, name, name_folded, created_at, updated_at) VALUES (NULL, 'deal', 'SALES', 'sales', 0, 0)",
    )
    refused(
      "INSERT INTO pipelines (account_id, external_id, name, name_folded, created_at, updated_at) VALUES (1, '0', 'B', 'b', 0, 0)",
    )
    refused("INSERT INTO pipelines (kind, name, name_folded, created_at, updated_at) VALUES ('task', 'X', 'x', 0, 0)")
    refused("UPDATE pipeline_stages SET outcome = 'maybe' WHERE id = 1")
    refused(
      "INSERT INTO pipeline_stages (pipeline_id, name, name_folded, position, external_id, created_at, updated_at) " +
        "VALUES (1, 'Again', 'again', 3, 'NEW', 0, 0)",
    )

    db.exec(
      "UPDATE pipeline_stages SET position = 2 WHERE id = 1; UPDATE pipeline_stages SET position = 1 WHERE id = 2",
    )
    expect(db.prepare("SELECT id FROM pipeline_stages WHERE pipeline_id = 1 ORDER BY position").all()).toEqual([
      { id: 2 },
      { id: 1 },
    ])

    const deal = (kind: string, stage: number) =>
      "INSERT INTO opportunities (kind, title, stage_id, status, review, author_type, author_id, source, created_at, " +
      `updated_at) VALUES ('${kind}', 'X', ${stage}, 'open', 'confirmed', 'person', 1, 'owner', 0, 0)`
    refused(deal("deal", 3))
    refused(deal("other", 3))
    db.exec(deal("lead", 3))
    refused("UPDATE opportunities SET kind = 'deal'")
    refused("UPDATE pipelines SET kind = 'deal' WHERE id = 4")
  } finally {
    db.close()
  }

  const store = await openStore({ path })
  try {
    expect((await store.deals.get("lead:1")).kind).toBe("lead")
    await expect(store.deals.get("deal:1")).rejects.toMatchObject({ code: "not_found" })
    expect((await store.refs.summaries(["lead:1", "deal:1"])).get("deal:1")?.state).toBe("unavailable")
    const crm = (await store.deals.pipelines()).find((one) => one.externalId === "0")
    expect(crm).toMatchObject({
      kind: "deal",
      account: { provider: "bitrix24", account: "one" },
      stages: [
        { name: "Won", position: 1, outcome: "won", externalId: "WON" },
        { name: "New", position: 2, outcome: "open", externalId: "NEW" },
      ],
    })
    await expect(store.deals.add({ by: "owner", title: "Y", stage: "New", pipeline: "Sales" })).rejects.toMatchObject({
      details: { reason: "pipeline.ambiguous" },
    })
  } finally {
    await store.close()
  }
})
