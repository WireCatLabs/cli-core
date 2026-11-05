import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { proposalRegistry } from "../services/proposals/registry.js"
import { type MessageStore, openStore } from "./store.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "orders-")), "store.db") })
  stores.push(store)
  const client = await store.knowledge.addOrganization({ kind: "company", name: "ООО Ромашка" })
  return { store, client }
}

it("keeps an agent's order proposed until the owner decides, and refuses the same shop's number twice", async () => {
  const { store, client } = await fixture()
  const proposed = await store.orders.add({
    by: { bot: "mail-triage" },
    reason: "the shop confirms the order",
    customer: client.ref,
    purpose: "client",
    supplierName: "Shop One",
    number: "A-1",
    total: "2499",
    currency: "RUB",
  })
  expect(proposed).toMatchObject({
    review: "proposed",
    status: "placed",
    total: "2499.00",
    customer: { ref: client.ref, owner: false },
    title: "Order A-1 · Shop One, 2 499.00 RUB (placed, proposed)",
  })
  await expect(
    store.orders.add({ by: "owner", purpose: "personal", supplierName: "SHOP ONE", number: "A-1" }),
  ).rejects.toMatchObject({ details: { reason: "order.duplicate" } })
  await expect(
    store.orders.add({ by: "owner", purpose: "personal", supplierName: "Shop Two", total: "10" }),
  ).rejects.toMatchObject({ details: { reason: "order.field" } })
  await expect(
    store.orders.setStatus(proposed.ref, { status: "shipped", by: { bot: "mail-triage" } }),
  ).rejects.toMatchObject({
    code: "permission_error",
  })

  const registry = proposalRegistry(store)
  const refused = await registry.decide([proposed.ref], { confirm: true, by: { bot: "other", reason: "ok" } })
  expect(refused.refused).toHaveLength(1)
  await registry.decide([proposed.ref], { confirm: true, by: "owner" })
  expect(await store.orders.list({ supplierName: "shop one", number: "A-1" })).toMatchObject([
    { ref: proposed.ref, review: "confirmed" },
  ])
  expect((await store.orders.setStatus(proposed.ref, { status: "returned", by: "owner" })).status).toBe("returned")
  expect((await store.refs.summaries([proposed.ref])).get(proposed.ref)).toMatchObject({
    title: "A-1 · Shop One, 2 499.00 RUB (returned)",
  })
})
