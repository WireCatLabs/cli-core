import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { proposalRegistry } from "../services/proposals/registry.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const claude = { bot: "claude-code", model: "synthetic" }

const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "subscriptions-")), "store.db")
  let clock = Date.UTC(2026, 10, 20)
  const store = await openStore({ path, now: () => clock++ })
  handles.push(store)
  const client = await store.knowledge.addOrganization({ kind: "company", name: "ООО Пример" })
  const hosting = await store.products.add({
    by: "owner",
    kind: "service",
    name: "Хостинг",
    unit: "month",
    unitPrice: "990.00",
    currency: "RUB",
  })
  const subscription = (by: "owner" | typeof claude = "owner") =>
    store.subscriptions.add({
      by,
      direction: "receivable",
      customer: client.ref,
      product: hosting.ref,
      every: "1-month",
      startDate: "2026-09-01",
      prices: [{ amount: "990.00", currency: "RUB" }],
    })
  return { store, path, client, hosting, subscription }
}

const reasonOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { details?: { reason?: string } }) => error.details?.reason,
  )

it("keeps every price as its own row and answers the one in force today", async () => {
  const f = await fixture()
  const made = await f.subscription()
  expect(made).toMatchObject({
    name: "Хостинг",
    interval: { count: 1, unit: "month" },
    status: "active",
    supplier: { owner: true },
    customer: { ref: f.client.ref },
    currentPrice: { amount: "990.00", currency: "RUB", effectiveFrom: "2026-09-01" },
    title: "Subscription Хостинг, 990.00 RUB every 1-month (active)",
  })
  await f.store.subscriptions.addPrice(made.ref, {
    by: "owner",
    amount: "1190.00",
    currency: "RUB",
    effectiveFrom: "2026-11-01",
  })
  await f.store.subscriptions.addPrice(made.ref, {
    by: "owner",
    amount: "1490.00",
    currency: "RUB",
    effectiveFrom: "2027-01-01",
  })
  const now = await f.store.subscriptions.get(made.ref)
  expect(now.currentPrice).toMatchObject({ amount: "1190.00", effectiveFrom: "2026-11-01" })
  expect(now.prices.map((price) => `${price.effectiveFrom} ${price.amount}`)).toEqual([
    "2026-09-01 990.00",
    "2026-11-01 1190.00",
    "2027-01-01 1490.00",
  ])
  expect(
    await reasonOf(
      f.store.subscriptions.addPrice(made.ref, {
        by: "owner",
        amount: "1.00",
        currency: "RUB",
        effectiveFrom: "2026-11-01",
      }),
    ),
  ).toBe("subscription.price")

  const database = await openCache(f.path)
  handles.push(database)
  expect(() =>
    database.prepare("UPDATE subscription_prices SET amount = 1 WHERE subscription_id = ?").run(Number(made.id)),
  ).toThrow(/a price is never changed/)
})

it("proposes an agent's new price on its own while the subscription stays confirmed", async () => {
  const f = await fixture()
  const made = await f.subscription()
  const price = await f.store.subscriptions.addPrice(made.ref, {
    by: claude,
    amount: "1290.00",
    currency: "RUB",
    effectiveFrom: "2026-10-01",
    reason: "the November invoice shows the new price",
  })
  expect(price).toMatchObject({ review: "proposed", reason: "the November invoice shows the new price" })
  expect((await f.store.subscriptions.get(made.ref)).review).toBe("confirmed")
  expect((await f.store.subscriptions.get(made.ref)).currentPrice?.amount).toBe("990.00")

  const registry = proposalRegistry(f.store)
  const page = await registry.list({ limit: 10, offset: 0, kinds: ["subscription_price"] })
  expect(page.items.map((row) => row.id)).toEqual([price.ref])
  const { decided } = await registry.decide([price.ref], { confirm: true, by: "owner" })
  expect(decided).toEqual([{ id: price.ref, kind: "subscription_price", status: "confirmed", made: [price.ref] }])
  expect((await f.store.subscriptions.get(made.ref)).currentPrice?.amount).toBe("1290.00")
})

it("decides an agent's subscription together with the prices it came with", async () => {
  const f = await fixture()
  const made = await f.subscription(claude)
  expect(made).toMatchObject({ review: "proposed", currentPrice: null, prices: [{ review: "proposed" }] })
  const first = made.prices[0]?.ref as string
  expect(await reasonOf(f.store.subscriptions.confirm(first, { bot: "codex", reason: "x" }))).toBe(
    "proposal.owner-only",
  )
  expect(await reasonOf(f.store.subscriptions.confirm(first, "owner"))).toBe("subscription.price")
  const confirmed = await f.store.subscriptions.confirm(made.ref, "owner")
  expect(confirmed).toMatchObject({
    review: "confirmed",
    prices: [{ review: "confirmed" }],
    currentPrice: { amount: "990.00" },
  })
  const later = await f.store.subscriptions.addPrice(made.ref, {
    by: claude,
    amount: "1.00",
    currency: "RUB",
    effectiveFrom: "2026-12-01",
  })
  expect(later.review).toBe("proposed")

  const other = await f.subscription(claude)
  const rejected = await f.store.subscriptions.reject(other.ref, "owner", "a duplicate")
  expect(rejected).toMatchObject({ review: "rejected", prices: [{ review: "rejected" }] })
})

it("cancels on today's date unless given, and refuses a trial without its end", async () => {
  const f = await fixture()
  const made = await f.subscription()
  expect(await f.store.subscriptions.update(made.ref, { by: "owner", status: "cancelled" })).toMatchObject({
    status: "cancelled",
    cancelledDate: "2026-11-20",
  })
  expect(
    await reasonOf(
      f.store.subscriptions.add({
        by: "owner",
        name: "Пробный",
        direction: "payable",
        supplier: f.client.ref,
        every: "2-week",
        startDate: "2026-11-01",
        status: "trial",
      }),
    ),
  ).toBe("subscription.field")
  expect(
    await reasonOf(
      f.store.subscriptions.add({
        by: "owner",
        name: "x",
        direction: "payable",
        supplier: f.client.ref,
        every: "monthly",
        startDate: "2026-11-01",
      }),
    ),
  ).toBe("subscription.interval")
})
