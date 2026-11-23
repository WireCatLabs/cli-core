import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { holdsKind, isDocumentAccountProvider } from "../domain/providers.js"
import { accountsOfList, sourceOf } from "../search/account-list.js"
import { type MessageStore, openStore } from "../store/store.js"
import { syncTracker } from "../tracker/index.js"
import { exampleTrackerRows, fakeTrackerSource } from "../tracker/testing/index.js"
import { groupGuardOf } from "./group-guard.js"
import { searchAll } from "./search-all.js"
import { listContextOf } from "./search-kind.js"

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

it("knows linear as a tracker and a documents account before linear-cli has written anything", () => {
  expect(holdsKind("linear", "tracker")).toBe(true)
  expect(holdsKind("linear", "documents")).toBe(true)
  expect(isDocumentAccountProvider("linear")).toBe(true)
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
      reason: "issues, projects and comments are found by the words and meaning of their title and text only",
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

describe("a Linear account with issues and documents", () => {
  const withDocuments = async () => {
    const store = await withIssues(LINEAR)
    const folder = await store.notes.documentsAccount(LINEAR, true)
    const { note } = await store.notes.saveFileNote({
      folderId: folder?.id ?? "",
      path: "doc-1.md",
      title: "Invoicing runbook",
      text: "How we send an invoice each month",
      frontMatter: { source: "linear", fileId: "doc-1" },
      contentHash: "doc-1",
    })
    await store.searchIndex.fillSearchIndex({})
    return { store, document: note.ref, notes: { resource: "notes", provider: "notes", account: folder?.id ?? "" } }
  }
  const linearIn = (found: Awaited<ReturnType<typeof searchAll>>) =>
    found.accounts.filter(({ provider, account }) =>
      provider === "linear" ? account === LINEAR.account : provider === "notes" && account !== "internal",
    )

  it("lists the account once in the notes lane and once in the tracker lane, and finds both", async () => {
    const { store, notes } = await withDocuments()
    const found = await searchAll(store, ME, { text: "invoic", limit: 20, only: ["notes", "tracker"] })
    expect(linearIn(found)).toEqual([notes, { resource: "tracker", ...LINEAR }])
    expect(found.items.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["issue", "document"]))
  })

  it("reads it once in each lane when --source names the provider or the account", async () => {
    const { store, notes } = await withDocuments()
    for (const source of ["linear", "linear:user-1", `linear,notes:${notes.account}`]) {
      const found = await searchAll(store, ME, { text: "invoic", limit: 20, only: ["notes", "tracker"], source })
      expect(linearIn(found), source).toEqual([notes, { resource: "tracker", ...LINEAR }])
      expect(
        found.items.map(({ kind }) => kind),
        source,
      ).toEqual(expect.arrayContaining(["issue", "document"]))
    }
  })

  it("leaves the tracker lane out when --source names only the documents", async () => {
    const { store, notes } = await withDocuments()
    const found = await searchAll(store, ME, {
      text: "invoic",
      limit: 20,
      only: ["notes", "tracker"],
      source: `notes:${notes.account}`,
    })
    expect(linearIn(found)).toEqual([notes])
  })

  it("keeps the account's tracker copy in a run locked to a group that names it", async () => {
    const { store } = await withDocuments()
    await store.accounts.saveAccountGroup("work", ["linear:user-1"])
    const app = { command: "memo", appName: "tracker-search", envPrefix: "MEMO", description: "", version: "0" }
    const context = await listContextOf(store, ME, app, undefined, { MEMO_GROUP_LOCK: "work" })
    expect(context.held.map(({ provider, account }) => `${provider}:${account}`)).toContain("linear:user-1")
    expect(accountsOfList("linear", context).map(sourceOf)).toContain("linear:user-1")
  })

  const app = { command: "memo", appName: "tracker-search", envPrefix: "MEMO", description: "", version: "0" }
  const LOCKED = { MEMO_GROUP_LOCK: "work" }

  it("lets a run locked to a group naming linear:<account> show the account's documents and issues", async () => {
    const { store, document } = await withDocuments()
    await store.accounts.saveAccountGroup("work", ["linear:user-1"])
    const found = await searchAll(store, ME, { text: "invoic", limit: 20, source: "group:work" }, { app })
    expect(found.items.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["issue", "document"]))
    const guard = await groupGuardOf(store, app, LOCKED)
    expect(document).toMatch(/^document:/)
    expect(await guard?.visible(document)).toBe(true)
    expect(await guard?.visible("tracker:linear/user-1/issue/issue-1")).toBe(true)
  })

  it("leaves the tracker lane out of a group naming only the documents", async () => {
    const { store, document, notes } = await withDocuments()
    await store.accounts.saveAccountGroup("work", [`notes:${notes.account}`])
    const found = await searchAll(store, ME, { text: "invoic", limit: 20, source: "group:work" }, { app })
    expect(found.searched).not.toContain("tracker")
    expect(found.items.map(({ kind }) => kind)).toContain("document")
    expect(await (await groupGuardOf(store, app, LOCKED))?.visible(document)).toBe(true)
  })
})
