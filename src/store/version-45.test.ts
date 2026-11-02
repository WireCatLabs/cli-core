import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("adds the finance tables to a version 44 file and keeps what it held", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-45-")), "wirecat.db")
  const store = await openStore({ path })
  const client = await store.knowledge.addOrganization({ kind: "company", name: "ООО Ромашка" })
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 45)
  expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'invoices'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  try {
    const invoice = await upgraded.finance.addInvoice({
      by: "owner",
      direction: "receivable",
      counterparty: client.ref,
      currency: "RUB",
      lines: [{ description: "Аренда", amount: "1500.50" }],
    })
    expect(invoice).toMatchObject({ total: "1500.50", counterparty: { name: "ООО Ромашка" }, status: "issued" })
  } finally {
    await upgraded.close()
  }
})
