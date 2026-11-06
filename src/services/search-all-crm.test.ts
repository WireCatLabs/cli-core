import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { providerEntryOf } from "../domain/providers.js"
import { type MessageStore, openStore } from "../store/store.js"
import { searchAll, titleWords } from "./search-all.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const ME = { provider: "telegram", account: "100" }

const withDeals = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-search-")), "store.db") })
  stores.push(store)
  await store.deals.addPipeline({ name: "Продажи", stages: ["Звонок", "КП"], by: "owner" })
  const deal = await store.deals.add({ by: "owner", title: "Сайт для Клиники", stage: "Звонок" })
  const lead = await store.deals.add({ by: "owner", kind: "lead", title: "Клиника на Ленина" })
  await store.deals.add({ by: "owner", title: "Логотип", stage: "КП" })
  return { store, deal, lead }
}

it("a crm provider entry is accepted, with the read commands that open its refs", () => {
  expect(
    providerEntryOf({ name: "example-crm", kind: "crm", opens: { deal: "deals show", lead: "leads show" } }),
  ).toMatchObject({ kind: "crm", opens: { deal: "deals show", lead: "leads show" } })
})

it("finds deals and leads by any part of a word of their title, in any letter case", async () => {
  const { store, deal, lead } = await withDeals()
  const found = await searchAll(store, ME, { text: "КЛИНИК", limit: 10, only: ["crm"] })
  expect(found.searched).toEqual(["crm"])
  expect(found.items.map(({ ref, kind }) => [kind, ref])).toEqual(
    expect.arrayContaining([
      ["deal", deal.ref],
      ["lead", lead.ref],
    ]),
  )
  expect(found.items).toHaveLength(2)
  expect(found.items[0]).toMatchObject({ provider: "crm", account: "internal", foundBy: ["title"] })
  expect(found.accounts).toEqual([{ resource: "crm", provider: "crm", account: "internal" }])
})

it("needs every word unless the query joins them with OR", async () => {
  const { store } = await withDeals()
  const all = await searchAll(store, ME, { text: "клиник логотип", limit: 10, only: ["crm"] })
  expect(all.items).toEqual([])
  const any = await searchAll(store, ME, { text: "клиник OR логотип", limit: 10, only: ["crm"] })
  expect(any.items).toHaveLength(3)
})

it("skips deals with the reason when the query names a field a title does not have", async () => {
  const { store } = await withDeals()
  const found = await searchAll(store, ME, { text: "from:anna клиник", limit: 10, only: ["crm"] })
  expect(found.searched).toEqual([])
  expect(found.skipped).toEqual([
    { resource: "crm", code: "validation_error", reason: "deals and leads are found by the words of their title only" },
  ])
  expect(() => titleWords("NOT клиника")).toThrow(/title only/)
})

it("reads only the accounts a scope names, so a locked profile never sees the owner's own deals", async () => {
  const { store } = await withDeals()
  const found = await searchAll(store, ME, {
    text: "КЛИНИК",
    limit: 10,
    only: ["crm"],
    scope: { crm: [{ provider: "example-crm", account: "portal" }] },
  })
  expect(found.items).toEqual([])
  expect(found.accounts).toEqual([{ resource: "crm", provider: "example-crm", account: "portal" }])
})
