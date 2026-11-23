import { createReadStream } from "node:fs"
import { afterEach, expect, it } from "vitest"
import { ingestLines, jsonlLines } from "../services/ingest.js"
import { recordsFixture } from "../testing/records.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const EXAMPLE = new URL("../../schemas/examples/records-business.jsonl", import.meta.url)
const KEY = { provider: "example-erp", account: "demo" }

it("removing an account takes the relationships it reported and leaves nothing pointing at its deals", async () => {
  const { store, sql } = await recordsFixture(handles)
  await ingestLines(store, jsonlLines(createReadStream(EXAMPLE)), { account: "demo" })
  const deal = String((await store.records.get({ ...KEY, type: "deal", externalId: "D-7" }))?.entity)
  await store.facts.add({ type: "fact", statement: "Blocked on legal", subject: deal, by: "owner" })
  const db = sql()
  const account = Number(db.prepare("SELECT id FROM accounts WHERE provider = ?").get(KEY.provider)?.id)
  const dealId = Number(deal.split(":")[1])
  expect(Number(db.prepare("SELECT count(*) AS n FROM links WHERE account_id = ?").get(account)?.n)).toBeGreaterThan(0)

  await store.accounts.purge(KEY)

  expect(Number(db.prepare("SELECT count(*) AS n FROM links WHERE account_id = ?").get(account)?.n)).toBe(0)
  const facts = db.prepare("SELECT count(*) AS n FROM facts WHERE subject_type = 'deal' AND subject_id = ?").get(dealId)
  expect(Number(facts?.n)).toBe(0)
})
