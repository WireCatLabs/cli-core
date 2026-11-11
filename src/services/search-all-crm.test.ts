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

it("finds deals and leads by the start of a word of their title, in any letter case", async () => {
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
    {
      resource: "crm",
      code: "validation_error",
      reason: "deals and leads are found by the words of their title, company and contacts only",
    },
  ])
  expect(() => titleWords("NOT клиника")).toThrow(/contacts only/)
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

const PORTAL = { provider: "example-crm", account: "portal" }

const synced = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-search-")), "store.db") })
  stores.push(store)
  await store.crm.savePipelines(PORTAL, "deal", [
    { externalId: "p1", name: "Sales", stages: [{ externalId: "s1", name: "New", position: 1, outcome: "open" }] },
  ])
  await store.crm.saveOrganizations(PORTAL, [{ externalId: "c1", name: "ООО «АкваБарьер»" }])
  await store.crm.savePeople(PORTAL, [
    { externalId: "5", name: "Ольга Белоусова", email: "o.belousova@example.test", phone: "+7 916 123-45-67" },
  ])
  const deal = (externalId: string, title: string, extra = {}) => ({
    externalId,
    title,
    pipeline: "p1",
    stage: "s1",
    createdAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, Number(externalId.slice(1))),
    ...extra,
  })
  await store.crm.saveItems(PORTAL, "deal", [
    deal("d1", "Поставка цемента М500", { organization: "c1", people: [{ externalId: "5", role: "contact" }] }),
    deal("d2", "Forklift repair"),
    deal("d3", "Window replacement at the office"),
    deal("d4", "Монтаж ТП «Вектор»"),
    deal("d5", "Подстанция КТП-630"),
  ])
  const refs = Object.fromEntries(
    (await store.deals.list({ account: PORTAL })).map((one) => [one.externalId as string, one.ref]),
  )
  const find = async (text: string, extra: Partial<Parameters<typeof searchAll>[2]> = {}) =>
    searchAll(store, ME, { text, limit: 10, only: ["crm"], ...extra })
  const refsOf = async (text: string) => (await find(text)).items.map(({ ref }) => ref)
  return { store, refs, find, refsOf }
}

it("finds another form of a word, Russian or English, and a word it begins", async () => {
  const { refs, refsOf } = await synced()
  expect(await refsOf("поставки цемента")).toEqual([refs.d1])
  expect(await refsOf("цемент")).toEqual([refs.d1])
  expect(await refsOf("repairs")).toEqual([refs.d2])
  expect(await refsOf("windows")).toEqual([refs.d3])
  expect(await refsOf("ктп-630")).toEqual([refs.d5])
})

it("never matches inside a word", async () => {
  const { refsOf } = await synced()
  expect(await refsOf("cement")).toEqual([])
  expect(await refsOf("ice")).toEqual([])
  expect(await refsOf("ктор")).toEqual([])
  expect(await refsOf(`"630 ктп"`)).toEqual([])
})

it("matches the start of a word only from four letters on", async () => {
  const { refs, refsOf } = await synced()
  expect(await refsOf("мон")).toEqual([])
  expect(await refsOf("монт")).toEqual([refs.d4])
})

it("finds a deal by its company and by its contact's name, e-mail and phone, and says the title did not match", async () => {
  const { refs, find, refsOf } = await synced()
  for (const text of ["АкваБарьер", "Белоусовой", "o.belousova@example.test", "+79161234567", "цемент Ольга"])
    expect(await refsOf(text), text).toEqual([refs.d1])
  expect((await find("АкваБарьер")).items[0]?.foundBy).toEqual(["words"])
  expect((await find("цемент")).items[0]?.foundBy).toEqual(["title"])
})

it("never finds a CRM copy by what another account holds of the same person", async () => {
  const { store, refs, refsOf } = await synced()
  const other = { provider: PORTAL.provider, account: "other-portal" }
  await store.crm.savePeople(other, [
    { externalId: "9", name: "Olga B", email: "o.belousova@example.test", phone: "+34 600 111 222" },
  ])
  const person = async (account: typeof PORTAL, id: string) =>
    (await store.people.personOf({ provider: PORTAL.provider, id: `${account.account}/contact/${id}` }))?.uid
  expect(await person(other, "9")).toBe(await person(PORTAL, "5"))
  expect(await refsOf("+34600111222")).toEqual([])
  expect(await refsOf("+79161234567")).toEqual([refs.d1])
})

it("ranks by the words matched when the query uses OR", async () => {
  const { refs, refsOf } = await synced()
  expect(await refsOf("repair OR window OR office")).toEqual([refs.d3, refs.d2])
})

it("corrects a misspelt word only when nothing matched, and says so", async () => {
  const { refs, find } = await synced()
  const found = await find("поствка цемента")
  expect(found.items.map(({ ref }) => ref)).toEqual([refs.d1])
  expect(found.items[0]).toMatchObject({ match: "corrected", corrections: [{ from: "поствка", to: ["поставка"] }] })
  expect((await find("поствка цемента", { exact: true })).items).toEqual([])
  expect((await find("цемента")).items[0]?.match).toBeUndefined()
})

it("skips deals with the reason when the query filters by stage, instead of finding nothing", async () => {
  const { find } = await synced()
  const found = await find("stage:won")
  expect(found.items).toEqual([])
  expect(found.skipped).toEqual([expect.objectContaining({ resource: "crm", reason: expect.stringMatching(/stage/) })])
})
