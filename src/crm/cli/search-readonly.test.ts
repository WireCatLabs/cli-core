import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { searchAll } from "../../services/search-all.js"
import { openStore } from "../../store/store.js"
import { syncCrm } from "../sync.js"
import { exampleDeal, fakeCrmSource } from "../testing/index.js"

const PORTAL = { provider: "example-crm", account: "portal" }

it("search all over a store only a CRM sync wrote answers from every source, read-only", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "crm-search-ro-")), "wirecat.db")
  const writable = await openStore({ path })
  const source = fakeCrmSource()
  source.put("deal", exampleDeal("d1", { title: "Example website" }))
  await syncCrm(source, writable, PORTAL)
  await writable.close()
  const store = await openStore({ path, readOnly: true })
  try {
    const found = await searchAll(
      store,
      PORTAL,
      { text: "website", limit: 10, env: {} },
      { app: { command: "crm", appName: "example-crm-cli", envPrefix: "CRM", description: "x", version: "1.0.0" } },
    )
    expect(found.skipped.map(({ resource }) => resource)).toEqual(["mail"])
    expect(found.items.map(({ kind }) => kind)).toEqual(["deal"])
  } finally {
    await store.close()
  }
})
