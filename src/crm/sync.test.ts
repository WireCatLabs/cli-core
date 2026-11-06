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
  await syncCrm(source, store, PORTAL, { now, budget: runBudget({ requests: 5 }) })
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
