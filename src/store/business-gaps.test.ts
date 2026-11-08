import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { refLabel } from "../domain/ref-summaries.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const claude = { bot: "claude-code", model: "synthetic" }

const fixture = async (start = Date.UTC(2026, 10, 20)) => {
  const path = join(mkdtempSync(join(tmpdir(), "business-gaps-")), "store.db")
  let clock = start
  const store = await openStore({ path, now: () => clock++ })
  handles.push(store)
  const client = await store.knowledge.addOrganization({ kind: "company", name: "ООО Пример" })
  const other = await store.knowledge.addOrganization({ kind: "company", name: "ООО Другой" })
  return { store, path, client, other }
}

const reasonOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { details?: { reason?: string } }) => error.details?.reason,
  )

it("titles a subscription with the price in force on the store's day, not the machine's", async () => {
  const f = await fixture(Date.UTC(2027, 5, 1))
  const made = await f.store.subscriptions.add({
    by: "owner",
    name: "Хостинг",
    direction: "receivable",
    customer: f.client.ref,
    every: "1-month",
    startDate: "2026-01-01",
    prices: [
      { amount: "990.00", currency: "RUB" },
      { amount: "1190.00", currency: "RUB", effectiveFrom: "2027-01-01" },
    ],
  })
  const summary = (await f.store.refs.summaries([made.ref])).get(made.ref)
  expect(refLabel(summary as NonNullable<typeof summary>)).toBe(
    "Subscription «Хостинг, 1 190.00 RUB every 1-month (active)»",
  )
})

it("changes every field of an agent's own proposed subscription, and none of a confirmed one", async () => {
  const f = await fixture()
  const proposed = await f.store.subscriptions.add({
    by: claude,
    name: "Поддержка",
    direction: "receivable",
    customer: f.client.ref,
    every: "1-month",
    startDate: "2026-11-01",
  })
  const changed = await f.store.subscriptions.update(proposed.ref, {
    by: claude,
    every: "3-month",
    customer: f.other.ref,
    startDate: "2026-12-01",
    trialEndDate: "2026-12-15",
    status: "trial",
  })
  expect(changed).toMatchObject({
    interval: { count: 3, unit: "month" },
    customer: { ref: f.other.ref },
    status: "trial",
    review: "proposed",
  })
  await f.store.subscriptions.confirm(proposed.ref, "owner")
  expect(await reasonOf(f.store.subscriptions.update(proposed.ref, { by: claude, name: "x" }))).toBe(
    "finance.owner-only",
  )
  expect(await f.store.subscriptions.update(proposed.ref, { by: "owner", status: "active" })).toMatchObject({
    status: "active",
  })
})

it("lists contracts by status, kind and expiry, and products by kind and supplier", async () => {
  const f = await fixture()
  const lease = await f.store.contracts.add({
    by: "owner",
    name: "Аренда",
    kind: "lease",
    expirationDate: "2026-12-31",
  })
  await f.store.contracts.add({ by: "owner", name: "NDA", kind: "nda", status: "draft" })
  expect((await f.store.contracts.list({ kind: "lease" })).map((one) => one.ref)).toEqual([lease.ref])
  expect((await f.store.contracts.list({ status: "draft" })).map((one) => one.name)).toEqual(["NDA"])
  expect((await f.store.contracts.list({ expiresBy: "2027-01-01" })).map((one) => one.ref)).toEqual([lease.ref])

  const theirs = await f.store.products.add({ by: "owner", name: "Подшипник", supplier: f.client.ref })
  await f.store.products.add({ by: "owner", name: "Консультация", kind: "service" })
  expect((await f.store.products.list({ supplier: f.client.ref })).map((one) => one.ref)).toEqual([theirs.ref])
  expect((await f.store.products.list({ kind: "service" })).map((one) => one.name)).toEqual(["Консультация"])
})

it("removes a split, and changes a transaction's amount only within its splits and its payment", async () => {
  const f = await fixture()
  const wallet = await f.store.wallets.add({ by: "owner", name: "Счёт", currency: "RUB" })
  const line = await f.store.transactions.add({
    by: "owner",
    wallet: wallet.ref,
    direction: "out",
    amount: "100.00",
    statementDate: "2026-11-05",
    splits: [
      { amount: "60.00", category: "Еда" },
      { amount: "30.00", category: "Такси" },
    ],
  })
  expect(await f.store.transactions.removeSplit(line.ref, { by: "owner", position: 1 })).toMatchObject({
    splits: [{ position: 2, category: "Такси" }],
    uncategorized: "70.00",
  })
  expect(await reasonOf(f.store.transactions.removeSplit(line.ref, { by: "owner", position: 7 }))).toBe(
    "transaction.no-split",
  )
  expect(await reasonOf(f.store.transactions.update(line.ref, { by: "owner", amount: "29.99" }))).toBe(
    "transaction.split",
  )
  expect(
    await f.store.transactions.update(line.ref, {
      by: "owner",
      amount: "120.00",
      statementDate: "2026-11-06",
      description: "Карта",
      counterpartyName: "Яндекс",
    }),
  ).toMatchObject({
    amount: "120.00",
    statementDate: "2026-11-06",
    bookedDate: "2026-11-05",
    counterpartyName: "Яндекс",
  })

  const payment = await f.store.finance.addPayment({
    by: "owner",
    direction: "out",
    amount: "120.00",
    currency: "RUB",
    date: "2026-11-06",
  })
  await f.store.transactions.update(line.ref, { by: "owner", payment: payment.ref })
  expect(await reasonOf(f.store.transactions.update(line.ref, { by: "owner", amount: "121.00" }))).toBe(
    "transaction.payment",
  )
  const proposed = await f.store.transactions.add({
    by: claude,
    wallet: wallet.ref,
    direction: "in",
    amount: "5.00",
    statementDate: "2026-11-07",
  })
  expect(await reasonOf(f.store.transactions.update(line.ref, { by: claude, description: "x" }))).toBe(
    "finance.owner-only",
  )
  expect(await f.store.transactions.update(proposed.ref, { by: claude, amount: "6.00" })).toMatchObject({
    amount: "6.00",
  })
})

it("keeps a confirmed price confirmed and every price row in place", async () => {
  const f = await fixture()
  const made = await f.store.subscriptions.add({
    by: "owner",
    name: "Хостинг",
    direction: "receivable",
    customer: f.client.ref,
    every: "1-month",
    startDate: "2026-09-01",
    prices: [{ amount: "990.00", currency: "RUB" }],
  })
  const database = await openCache(f.path)
  handles.push(database)
  const id = Number(made.prices[0]?.id)
  expect(() => database.prepare("UPDATE subscription_prices SET review = 'proposed' WHERE id = ?").run(id)).toThrow(
    /never changed/,
  )
  expect(() => database.prepare("DELETE FROM subscription_prices WHERE id = ?").run(id)).toThrow(/never deleted/)
})
