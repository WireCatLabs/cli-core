import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { ingest } from "../services/ingest.js"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("adds the records tables to a version 46 file and keeps what it held", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-47-")), "wirecat.db")
  const store = await openStore({ path })
  const client = await store.knowledge.addOrganization({ kind: "company", name: "ООО Ромашка" })
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 47)
  expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'records'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  try {
    const receipt = await ingest(
      upgraded,
      {
        schema_version: 1,
        source: { provider: "sheet", account: "demo-rent", batch_id: "1" },
        records: [
          { key: "c", type: "custom:note", external_id: "1", operation: "upsert", fields: { client: client.ref } },
        ],
      },
      { account: "demo-rent" },
    )
    expect(receipt).toMatchObject({ created: 1, errors: [] })
  } finally {
    await upgraded.close()
  }
})
