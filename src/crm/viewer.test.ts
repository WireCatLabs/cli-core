import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { crmIdentityId } from "../store/sqlite/crm.js"
import { type MessageStore, openStore } from "../store/store.js"
import { type CrmViewing, crmViewerOf, syncCrm } from "./index.js"
import { exampleDeal, fakeCrmSource } from "./testing/index.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const PORTAL = { provider: "example-crm", account: "portal" }

it("tells a caller outside a CRM command whose part of a copy each user reads offline", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-viewer-")), "store.db") })
  stores.push(store)
  const source = fakeCrmSource({ self: "7" })
  source.put("deal", exampleDeal("d1", { assignee: "7" }))
  await syncCrm(source, store, PORTAL)

  const own: CrmViewing = await crmViewerOf(store, PORTAL, "7")
  expect(own).toEqual({ viewer: { account: PORTAL, assignee: crmIdentityId(PORTAL, "7", "user") } })
  expect(await crmViewerOf(store, PORTAL, null)).toEqual({
    viewer: { account: PORTAL, assignee: null },
    note: expect.stringContaining("names no CRM user"),
  })
})
