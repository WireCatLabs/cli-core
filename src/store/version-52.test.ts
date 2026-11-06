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
