import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { openStore, syncCrm } from "@wirecat/cli-core"
import { exampleDeal, fakeCrmSource } from "@wirecat/cli-core/testing"

const path = process.argv[2]
assert.ok(path && !existsSync(path), "supply a new isolated database path")
const account = { provider: "example-crm", account: "portal.example.test" }
const store = await openStore({ path })
try {
  await store.accounts.registerProvider({ name: account.provider, kind: "crm", aliases: [] })
  const source = fakeCrmSource({ self: "7" })
  source.put("deal", exampleDeal("d1", { title: "Synthetic minimum-Node deal", assignee: "7" }))
  await syncCrm(source, store, account)
  // The digest's reads: counts with no page, and a page with no change, owner or pipeline filter.
  const window = { since: 0, until: Date.now() + 86_400_000 }
  const counts = await store.crm.changeCounts(account, window)
  assert.equal(counts.created, 1)
  const page = await store.crm.changes(account, { ...window, limit: 5, offset: 0 })
  assert.equal(page.items.length, 1)
  const viewer = { account, assignee: "example-crm:portal.example.test/user/7" }
  await store.crm.changes(account, { ...window, changes: ["created"], owner: null, viewer, limit: 5, offset: 0 })
  process.stdout.write(`${JSON.stringify({ node: process.version, crm_changes: true })}\n`)
} finally {
  await store.close()
}
