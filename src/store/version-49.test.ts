import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { ingest } from "../services/ingest.js"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("adds amounts to the record relations of a version 48 file and keeps the relations it held", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-49-")), "wirecat.db")
  const source = { provider: "sheet", account: "prokat-med", batch_id: "1" }
  const store = await openStore({ path })
  await ingest(
    store,
    {
      schema_version: 1,
      source,
      records: [
        {
          key: "p",
          type: "custom:transfer",
          external_id: "1",
          operation: "upsert",
          fields: {},
          relations: [{ role: "settles", type: "invoice", external_id: "SEO-03" }],
        },
      ],
    },
    { account: "prokat-med" },
  )
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 49)
  expect(old.prepare("SELECT name FROM pragma_table_info('record_relations') WHERE name = 'amount'").get()).toBe(
    undefined,
  )
  old.close()

  const upgraded = await openStore({ path })
  try {
    const record = await upgraded.records.get({ ...source, type: "custom:transfer", externalId: "1" })
    expect(record?.relations).toEqual([expect.objectContaining({ role: "settles", externalId: "SEO-03" })])
  } finally {
    await upgraded.close()
  }
})
