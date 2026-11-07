import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { runBudget } from "../background/budget.js"
import { type MessageStore, openStore } from "../store/store.js"
import { crmStatus, parseCrmCursor, syncCrm } from "./index.js"
import { exampleDeal, fakeCrmSource } from "./testing/index.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const PORTAL = { provider: "example-crm", account: "portal" }

it("store status says which kinds a stopped sync left partial, and how much each holds", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-status-")), "store.db") })
  stores.push(store)
  const source = fakeCrmSource({ traits: { removedInChanges: true } })
  for (const id of ["d1", "d2", "d3"]) source.put("deal", exampleDeal(id))
  const now = Date.now()
  await syncCrm(source, store, PORTAL, { now, budget: runBudget({ requests: 9 }) })
  const { items } = await crmStatus(store, PORTAL, { profile: "work", now })
  expect(items.map(({ kind, state, stored }) => [kind, state, stored])).toEqual([
    ["organization", "complete", 0],
    ["person", "complete", 0],
    ["deal", "partial", 2],
    ["lead", "partial", 0],
  ])
  expect(items[2]).toMatchObject({ round: "full", job: "crm deal", profile: "work" })
})

it("a cursor another build wrote in a shape this one does not know reads as none", () => {
  expect(parseCrmCursor('{"v":2}')).toBeNull()
  expect(parseCrmCursor("not json")).toBeNull()
  expect(parseCrmCursor(null)).toBeNull()
})

it("says on the first sync, and only then, how to add an ungrouped CRM account to a work group", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-hint-")), "store.db") })
  stores.push(store)
  const source = fakeCrmSource()
  source.put("deal", exampleDeal("d1"))
  const first = await syncCrm(source, store, PORTAL)
  expect(first.groupHint).toBe("add it to a work group: `memo groups add work example-crm:portal`")
  expect((await syncCrm(source, store, PORTAL)).groupHint).toBeUndefined()
})

it("gives no work group hint for a CRM account a saved group other than personal lists", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-hint-")), "store.db") })
  stores.push(store)
  await store.accounts.saveAccount(PORTAL, { name: null })
  await store.accounts.saveAccountGroup("sales", ["example-crm:portal"])
  const source = fakeCrmSource()
  source.put("deal", exampleDeal("d1"))
  expect((await syncCrm(source, store, PORTAL)).groupHint).toBeUndefined()
})

it("still hints for a CRM account whose profile is named work but no group lists, or only personal does", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-hint-")), "store.db") })
  stores.push(store)
  await store.accounts.saveAccount(PORTAL, { name: null })
  await store.accounts.saveProfile("crm", "work", PORTAL)
  await store.accounts.saveAccountGroup("personal", ["example-crm:portal"])
  const source = fakeCrmSource()
  source.put("deal", exampleDeal("d1"))
  expect((await syncCrm(source, store, PORTAL)).groupHint).toMatch(/memo groups add work example-crm:portal/)
})

it("still hints for a CRM account when a work group exists without it", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-hint-")), "store.db") })
  stores.push(store)
  await store.accounts.saveAccount(PORTAL, { name: null })
  await store.accounts.saveAccount({ provider: "telegram", account: "102" }, { name: null })
  await store.accounts.saveAccountGroup("work", ["telegram:102"])
  const source = fakeCrmSource()
  source.put("deal", exampleDeal("d1"))
  expect((await syncCrm(source, store, PORTAL)).groupHint).toMatch(/memo groups add work example-crm:portal/)
})
