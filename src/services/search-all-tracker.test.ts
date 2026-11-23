import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { holdsKind } from "../domain/providers.js"
import { type MessageStore, openStore } from "../store/store.js"
import { syncTracker } from "../tracker/index.js"
import { exampleTrackerRows, fakeTrackerSource } from "../tracker/testing/index.js"
import { searchAll } from "./search-all.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const ME = { provider: "telegram", account: "100" }
const LINEAR = { provider: "linear", account: "user-1" }
const OTHER = { provider: "linear", account: "user-2" }

const withIssues = async (...accounts: { provider: string; account: string }[]) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "tracker-search-")), "store.db") })
  stores.push(store)
  for (const account of accounts)
    await syncTracker(fakeTrackerSource({ rows: exampleTrackerRows() }), store, account, {
      now: Date.UTC(2026, 10, 17),
    })
  return store
}

it("knows linear as a tracker before linear-cli has written anything", () => {
  expect(holdsKind("linear", "tracker")).toBe(true)
})

it("finds issues, projects and comments by their words, titled as people say an issue", async () => {
  const store = await withIssues(LINEAR)
  const found = await searchAll(store, ME, { text: "invoic", limit: 10, only: ["tracker"] })
  expect(found.searched).toEqual(["tracker"])
  expect(found.items.map(({ kind, ref }) => [kind, ref]).sort()).toEqual([
    ["issue", "tracker:linear/user-1/issue/issue-1"],
    ["project", "tracker:linear/user-1/project/project-1"],
  ])
  const issue = found.items.find(({ kind }) => kind === "issue")
  expect(issue).toMatchObject({ provider: "linear", account: "user-1", foundBy: ["words"] })
  expect(issue?.title).toMatch(/^ENG-1 /)
  expect(found.accounts).toEqual([{ resource: "tracker", provider: "linear", account: "user-1" }])

  const comment = await searchAll(store, ME, { text: "accounts", limit: 10, only: ["tracker"] })
  expect(comment.items.map(({ kind }) => kind)).toContain("issue_comment")
})

it("reads every tracker account, and only the ones --source names", async () => {
  const store = await withIssues(LINEAR, OTHER)
  const all = await searchAll(store, ME, { text: "invoic", limit: 10, only: ["tracker"] })
  expect(new Set(all.items.map(({ account }) => account))).toEqual(new Set(["user-1", "user-2"]))
  expect(all.accounts.map(({ account }) => account).sort()).toEqual(["user-1", "user-2"])

  const one = await searchAll(store, ME, { text: "invoic", limit: 10, only: ["tracker"], scope: { tracker: [OTHER] } })
  expect(new Set(one.items.map(({ account }) => account))).toEqual(new Set(["user-2"]))
})

it("is one of the lanes a plain search all reads, beside the others", async () => {
  const store = await withIssues(LINEAR)
  const found = await searchAll(store, ME, { text: "invoic", limit: 10 })
  expect(found.searched).toContain("tracker")
  expect(found.items.some(({ kind }) => kind === "issue")).toBe(true)
})

it("skips the tracker with the reason when the query names a field an issue does not have", async () => {
  const store = await withIssues(LINEAR)
  const found = await searchAll(store, ME, { text: "from:anna invoic", limit: 10, only: ["tracker"] })
  expect(found.searched).toEqual([])
  expect(found.skipped).toEqual([
    expect.objectContaining({
      resource: "tracker",
      code: "validation_error",
      reason: "issues, projects and comments are found by the words of their title and text only",
    }),
  ])
})

it("leaves the lane out quietly when the store has no tracker account", async () => {
  const store = await withIssues()
  const found = await searchAll(store, ME, { text: "from:anna invoic", limit: 10 })
  expect(found.searched).not.toContain("tracker")
  expect(found.skipped.map(({ resource }) => resource)).not.toContain("tracker")
})

it("shows no hits of a provider the registry does not call a tracker", async () => {
  const store = await withIssues(LINEAR, { provider: "unknown-tracker", account: "u" })
  const found = await searchAll(store, ME, { text: "invoic", limit: 10, only: ["tracker"] })
  expect(new Set(found.items.map(({ provider }) => provider))).toEqual(new Set(["linear"]))
  expect(found.accounts).toEqual([{ resource: "tracker", provider: "linear", account: "user-1" }])
})
