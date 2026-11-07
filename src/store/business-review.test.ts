import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { refLabel } from "../domain/ref-summaries.js"
import { proposalRegistry } from "../services/proposals/registry.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const claude = { bot: "claude-code", model: "synthetic" }
const codex = { bot: "codex", reason: "the scan shows it signed" }

const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "business-review-")), "store.db")
  let clock = Date.UTC(2026, 10, 7)
  const store = await openStore({
    path,
    now: () => clock++,
    decisions: { agentDecisions: true, ruleProposalsOwnerOnly: true },
  })
  handles.push(store)
  const contract = (by: "owner" | typeof claude, extra: Record<string, unknown> = {}) =>
    store.contracts.add({
      by,
      name: "Rental agreement",
      number: "K-2026-14",
      kind: "service",
      effectiveDate: "2026-11-01",
      expirationDate: "2027-10-31",
      autoRenew: true,
      renewal: "1-year",
      noticeDays: 30,
      ...extra,
    })
  return { store, contract, registry: proposalRegistry(store) }
}

const reasonOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { details?: { reason?: string } }) => error.details?.reason,
  )

it("writes a contract without a value confirmed by anyone, and proposes an agent's with one", async () => {
  const f = await fixture()
  const plain = await f.contract(claude)
  expect(plain).toMatchObject({
    review: "confirmed",
    status: "active",
    autoRenew: true,
    renewal: { count: 1, unit: "year" },
    noticeDeadline: "2027-10-01",
    value: null,
  })
  const valued = await f.contract(claude, { value: "120000.00", currency: "RUB" })
  expect(valued).toMatchObject({ review: "proposed", value: "120000.00", currency: "RUB" })
  expect(valued.title).toBe("Contract K-2026-14 · Rental agreement, 120 000.00 RUB (active, proposed)")
  const owners = await f.contract("owner", { value: "5000.00", currency: "EUR" })
  expect(owners.review).toBe("confirmed")

  expect(await reasonOf(f.store.contracts.update(plain.ref, { by: claude, value: "1.00", currency: "RUB" }))).toBe(
    "finance.owner-only",
  )
  expect(await f.store.contracts.update(plain.ref, { by: claude, status: "ended" })).toMatchObject({ status: "ended" })
  expect(await f.store.contracts.update(plain.ref, { by: "owner", value: "1.00", currency: "RUB" })).toMatchObject({
    value: "1.00",
  })
  expect(await reasonOf(f.contract("owner", { effectiveDate: "2027-11-01" }))).toBe("contract.field")
})

it("lists every business proposal in the inbox and lets only the owner decide them", async () => {
  const f = await fixture()
  const wallet = await f.store.wallets.add({ by: claude, name: "Счёт", currency: "RUB" })
  const contract = await f.contract(claude, { value: "120000.00", currency: "RUB" })
  const client = await f.store.knowledge.addOrganization({ kind: "company", name: "ООО Пример" })
  const subscription = await f.store.subscriptions.add({
    by: claude,
    name: "Поддержка",
    direction: "receivable",
    customer: client.ref,
    every: "1-month",
    startDate: "2026-11-01",
  })
  const transaction = await f.store.transactions.add({
    by: claude,
    wallet: wallet.ref,
    direction: "in",
    amount: "10000.00",
    date: "2026-11-05",
    counterpartyName: "ООО Пример",
  })
  const order = await f.store.orders.add({
    by: claude,
    purpose: "business",
    supplierName: "Ozon",
    currency: "RUB",
    total: "1.00",
  })

  const page = await f.registry.list({
    limit: 10,
    offset: 0,
    kinds: ["contract", "subscription", "transaction", "order"],
  })
  expect(page.items.map((row) => row.id).sort()).toEqual(
    [contract.ref, order.ref, subscription.ref, transaction.ref].sort(),
  )
  const refused = await f.registry.decide([contract.ref, transaction.ref], { confirm: true, by: codex })
  expect(refused.decided).toEqual([])
  expect(refused.refused.map((one) => one.reason)).toEqual(["proposal.owner-only", "proposal.owner-only"])

  const done = await f.registry.decide([contract.ref, subscription.ref, transaction.ref], {
    confirm: true,
    by: "owner",
  })
  expect(done.decided.map((one) => one.status)).toEqual(["confirmed", "confirmed", "confirmed"])
  expect((await f.store.contracts.get(contract.ref)).confirmedBy).toMatchObject({ type: "person" })
  expect(await reasonOf(f.store.contracts.confirm(contract.ref, "owner"))).toBe("proposal.wrong-state")

  const summaries = await f.store.refs.summaries([contract.ref, subscription.ref, transaction.ref])
  expect([...summaries.values()].map(refLabel)).toEqual([
    "Contract «K-2026-14 · Rental agreement, 120 000.00 RUB (active)»",
    "Subscription «Поддержка every 1-month (active)»",
    "Transaction «10 000.00 RUB in · ООО Пример, 05.11» (Счёт)",
  ])
})

it("writes products directly for anyone and keeps a code once per supplier", async () => {
  const f = await fixture()
  const made = await f.store.products.add({
    by: claude,
    name: "Чай",
    sku: "TEA-1",
    unitPrice: "250.00",
    currency: "RUB",
  })
  expect(made).toMatchObject({ kind: "product", supplier: null, author: { type: "bot", name: "claude-code" } })
  expect(await reasonOf(f.store.products.add({ by: "owner", name: "Чай 2", sku: "TEA-1" }))).toBe("product.duplicate")
  expect(await reasonOf(f.store.products.add({ by: "owner", name: "Кофе", unitPrice: "1.00" }))).toBe("product.field")
  await f.store.products.update(made.ref, { by: "owner", archivedDate: "2026-11-07" })
  expect((await f.store.products.list({ archived: false })).map((one) => one.ref)).toEqual([])
  expect((await f.store.products.list({ name: "чай" })).map((one) => one.title)).toEqual([
    "Чай · 250.00 RUB (product, archived)",
  ])
})
