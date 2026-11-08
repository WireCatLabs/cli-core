import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { formatDecimal, signedMinorUnits } from "../domain/money.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "business-money-")), "store.db")
  let clock = Date.UTC(2026, 10, 20)
  const store = await openStore({ path, now: () => clock++ })
  handles.push(store)
  return store
}

const reasonOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { details?: { reason?: string } }) => error.details?.reason,
  )

it("reads and writes signed decimals in the currency's scale", () => {
  expect(signedMinorUnits("-1200.50", "RUB")).toBe(-120050)
  expect(signedMinorUnits("-0.00", "RUB")).toBe(0)
  expect(signedMinorUnits("-1.234", "BHD")).toBe(-1234)
  expect(formatDecimal(-5, 2)).toBe("-0.05")
  expect(formatDecimal(-1234, 3)).toBe("-1.234")
  expect(formatDecimal(-700, 0)).toBe("-700")
})

it("keeps yen without decimals and dinars with three on every new table, and never adds currencies together", async () => {
  const store = await fixture()
  const tokyo = await store.wallets.add({
    by: "owner",
    name: "MUFG",
    currency: "JPY",
    openingBalance: "-5000",
    openingDate: "2026-10-31",
  })
  const manama = await store.wallets.add({ by: "owner", name: "NBB", currency: "BHD" })
  expect(
    await reasonOf(
      store.transactions.add({
        by: "owner",
        wallet: tokyo.ref,
        direction: "in",
        amount: "1.5",
        statementDate: "2026-11-01",
      }),
    ),
  ).toBe("money.amount")
  await store.transactions.add({
    by: "owner",
    wallet: tokyo.ref,
    direction: "in",
    amount: "12000",
    statementDate: "2026-11-01",
    splits: [{ amount: "2000", category: "Food" }],
  })
  await store.transactions.add({
    by: "owner",
    wallet: manama.ref,
    direction: "out",
    amount: "1.250",
    statementDate: "2026-11-02",
    splits: [{ amount: "0.125", category: "food" }],
  })
  expect((await store.wallets.get(tokyo.ref)).balance).toEqual({ amount: "7000", currency: "JPY" })
  expect((await store.wallets.get(manama.ref)).balance).toEqual({ amount: "-1.250", currency: "BHD" })
  expect(await store.transactions.categories()).toEqual([
    { category: "food", amount: "0.125", currency: "BHD" },
    { category: "Food", amount: "2000", currency: "JPY" },
    { category: null, amount: "1.125", currency: "BHD" },
    { category: null, amount: "10000", currency: "JPY" },
  ])

  const product = await store.products.add({ by: "owner", name: "Matcha", unitPrice: "1500", currency: "JPY" })
  expect(product.unitPrice).toBe("1500")
  expect(await reasonOf(store.products.add({ by: "owner", name: "Dates", unitPrice: "1.2345", currency: "BHD" }))).toBe(
    "money.amount",
  )
  const contract = await store.contracts.add({
    by: "owner",
    name: "Lease",
    kind: "lease",
    value: "1200.500",
    currency: "BHD",
  })
  expect(contract).toMatchObject({ value: "1200.500", title: "Contract #1 · Lease, 1 200.500 BHD (active)" })
  const client = await store.knowledge.addOrganization({ kind: "company", name: "株式会社サンプル" })
  const subscription = await store.subscriptions.add({
    by: "owner",
    name: "Support",
    direction: "receivable",
    customer: client.ref,
    every: "1-year",
    startDate: "2026-01-01",
    prices: [{ amount: "98000", currency: "JPY" }],
  })
  expect(subscription.currentPrice).toMatchObject({ amount: "98000", currency: "JPY" })
})
