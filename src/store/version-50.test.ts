import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("adds the orders table to a version 49 file and keeps what it held", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-50-")), "wirecat.db")
  const store = await openStore({ path })
  const shop = await store.knowledge.addOrganization({ kind: "company", name: "Shop One" })
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 50)
  expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'orders'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  try {
    const order = await upgraded.orders.add({
      by: "owner",
      purpose: "personal",
      supplier: shop.ref,
      supplierName: "Shop One",
    })
    expect(order).toMatchObject({ status: "placed", supplier: { name: "Shop One" }, customer: { owner: true } })
  } finally {
    await upgraded.close()
  }
})
