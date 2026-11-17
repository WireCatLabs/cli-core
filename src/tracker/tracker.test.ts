import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runBudget } from "../background/budget.js"
import { type MessageStore, openStore } from "../store/store.js"
import { syncTracker } from "./sync.js"
import { trackerIssueTask } from "./tasks.js"
import { exampleTrackerRows, fakeTrackerSource, trackerSourceContract } from "./testing/index.js"

const account = { provider: "fake-tracker", account: "workspace" }
const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const storeOf = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "tracker-")), "store.db") })
  stores.push(store)
  return store
}

describe("fake tracker source", () => {
  for (const c of trackerSourceContract(() => {
    const rows = exampleTrackerRows()
    const source = fakeTrackerSource({ rows })
    const held = Object.fromEntries(
      Object.entries(rows).map(([kind, list]) => [kind, list.map((one) => one.externalId)]),
    )
    return {
      source,
      held,
      deadCursor: { kind: "issue", cursor: "not a time" },
      faults: {
        skewed: (ms) => source.skewed(ms),
        change: () => {
          source.touch("issue", "issue-2")
          return { kind: "issue", id: "issue-2" }
        },
        archive: () => {
          source.archive("issue", "issue-3")
          return { kind: "issue", id: "issue-3" }
        },
        remove: () => {
          source.remove("issue", "issue-3")
          return { kind: "issue", id: "issue-3" }
        },
      },
    }
  }))
    it(c.name, c.run)
})

describe("syncTracker", () => {
  it("copies every kind, then reads only changes, and finds archived and deleted rows", async () => {
    const store = await storeOf()
    const rows = exampleTrackerRows()
    const source = fakeTrackerSource({ rows })
    const now = Date.UTC(2026, 10, 17)

    const first = await syncTracker(source, store, account, { now })
    expect(first.state).toBe("complete")
    expect(first.synced.map((one) => [one.kind, one.round, one.pass])).toEqual(
      ["team", "user", "state", "label", "project", "issue", "comment"].map((kind) => [kind, "full", "complete"]),
    )
    expect(await store.tracker.count(account, "issue")).toBe(3)

    source.touch("issue", "issue-1")
    source.archive("issue", "issue-2")
    source.remove("issue", "issue-3")
    const second = await syncTracker(source, store, account, { now: now + 60_000 })
    const issues = second.synced.find((one) => one.kind === "issue")
    expect(issues).toMatchObject({ round: "changes", unlisted: 0 })
    expect(issues?.pass).toBeUndefined()
    expect((await store.tracker.get(account, "issue", "issue-2"))?.record.archivedAt).toEqual(expect.any(Number))
    expect((await store.tracker.list(account, "issue")).items.map((one) => one.record.externalId)).toEqual([
      "issue-1",
      "issue-3",
    ])

    const third = await syncTracker(source, store, account, { now: now + 2 * 86_400_000 })
    expect(third.synced.find((one) => one.kind === "issue")).toMatchObject({ pass: "complete", unlisted: 1 })
    expect((await store.tracker.get(account, "issue", "issue-3"))?.deletedAt).toEqual(expect.any(Number))
    expect((await store.tracker.list(account, "issue", { archived: true })).items).toHaveLength(2)
  })

  it("stops on its budget and goes on from the page it reached", async () => {
    const store = await storeOf()
    const source = fakeTrackerSource({ rows: exampleTrackerRows(), pageSize: 1 })
    const now = Date.UTC(2026, 10, 17)
    const cut = await syncTracker(source, store, account, { now, budget: runBudget({ requests: 3 }) })
    expect(cut).toMatchObject({ state: "partial", stopped: "requests", complete: false })
    let rest = cut
    for (let run = 0; run < 50 && rest.state === "partial"; run += 1)
      rest = await syncTracker(source, store, account, { now, budget: runBudget({ requests: 3 }) })
    expect(rest.state).toBe("complete")
    expect(await store.tracker.count(account, "state")).toBe(6)
    expect(await store.tracker.count(account, "issue")).toBe(3)
  })

  it("names a kind that fails and still syncs the others", async () => {
    const store = await storeOf()
    const source = fakeTrackerSource({ rows: exampleTrackerRows() })
    const broken = {
      ...source,
      changes: (async (kind, cursor, page, context) => {
        if (kind === "label") throw new Error("labels refused")
        return source.changes(kind, cursor, page, context)
      }) as typeof source.changes,
    }
    const report = await syncTracker(broken, store, account, { now: Date.UTC(2026, 10, 17) })
    expect(report.state).toBe("partial")
    expect(report.synced.find((one) => one.kind === "label")?.error).toBe("labels refused")
    expect(await store.tracker.count(account, "issue")).toBe(3)
  })
})

describe("syncTracker guards", () => {
  const DAYS = 2 * 86_400_000
  const T = Date.UTC(2026, 10, 17)

  it("holds an id pass that would empty a kind, or follows a gap, until --rescan lets it through", async () => {
    const store = await storeOf()
    const source = fakeTrackerSource({ rows: exampleTrackerRows() })
    await syncTracker(source, store, account, { now: T })
    const lost = { ...source, ids: (async () => ({ items: [], hasMore: false })) as typeof source.ids }
    const held = await syncTracker(lost, store, account, { now: T + DAYS })
    expect(held.synced.find((one) => one.kind === "issue")).toMatchObject({ pass: "held", unlisted: 0 })
    expect(held.synced.find((one) => one.kind === "issue")?.held).toMatch(/run sync --rescan/)
    expect(await store.tracker.count(account, "issue")).toBe(3)

    const gapped = {
      ...source,
      ids: (async (kind, page, context) => {
        if (kind === "comment") context?.gap({ kind, message: "the sign-in cannot read one team's comments" })
        return source.ids(kind, page, context)
      }) as typeof source.ids,
    }
    source.remove("comment", "comment-1")
    const partly = await syncTracker(gapped, store, account, { now: T + 2 * DAYS })
    expect(partly.synced.find((one) => one.kind === "comment")?.pass).toBe("held")
    expect(await store.tracker.count(account, "comment")).toBe(1)

    const emptied = {
      ...lost,
      changes: (async () => ({ items: [], hasMore: false, cursor: null })) as unknown as typeof source.changes,
    }
    const through = await syncTracker(emptied, store, account, { now: T + 3 * DAYS, rescan: true })
    expect(through.synced.find((one) => one.kind === "issue")).toMatchObject({ pass: "complete", unlisted: 3 })
  })

  it("fails a kind whose page says there is more but gives no cursor, keeping the old cursor", async () => {
    const store = await storeOf()
    const source = fakeTrackerSource({ rows: exampleTrackerRows() })
    const broken = {
      ...source,
      changes: (async () => ({ items: [], hasMore: true })) as unknown as typeof source.changes,
    }
    const report = await syncTracker(broken, store, account, { now: T })
    expect(report.synced[0]?.error).toMatch(/gave no cursor/)
    expect(report.state).toBe("partial")
  })

  it("goes on with a stopped --rescan as a rescan: the kinds it had not reached get a full list and an id pass", async () => {
    const store = await storeOf()
    const source = fakeTrackerSource({ rows: exampleTrackerRows() })
    await syncTracker(source, store, account, { now: T })
    const cut = await syncTracker(source, store, account, {
      now: T + 1,
      rescan: true,
      budget: runBudget({ requests: 3 }),
    })
    expect(cut.stopped).toBe("requests")
    const rest = await syncTracker(source, store, account, { now: T + 2 })
    expect(rest.state).toBe("complete")
    for (const one of rest.synced) expect(one).toMatchObject({ round: "full", pass: "complete" })
    const after = await syncTracker(source, store, account, { now: T + 3 })
    expect(after.synced.every((one) => one.round === "changes" && one.pass === undefined)).toBe(true)
  })

  it("stops an id pass when cancelled, keeping the ids it read", async () => {
    const store = await storeOf()
    const source = fakeTrackerSource({ rows: exampleTrackerRows(), pageSize: 1 })
    const controller = new AbortController()
    const cancelling = {
      ...source,
      ids: (async (kind, page, context) => {
        if (kind === "state" && page !== undefined) controller.abort()
        return source.ids(kind, page, context)
      }) as typeof source.ids,
    }
    const report = await syncTracker(cancelling, store, account, { now: T, signal: controller.signal })
    expect(report).toMatchObject({ stopped: "cancelled", state: "partial" })
    expect(report.synced.find((one) => one.kind === "state")).toMatchObject({ pass: "partial", unlisted: 0 })
  })
})

describe("store.tracker", () => {
  it("filters issues by state type, assignee and label, and finds them by their words", async () => {
    const store = await storeOf()
    await syncTracker(fakeTrackerSource({ rows: exampleTrackerRows() }), store, account, {
      now: Date.UTC(2026, 10, 17),
    })
    const ids = async (filter: Parameters<MessageStore["tracker"]["list"]>[2]) =>
      (await store.tracker.list(account, "issue", filter)).items.map((one) => one.record.externalId)
    expect(await ids({ stateTypes: ["started", "unstarted"] })).toEqual(["issue-2", "issue-1"])
    expect(await ids({ assignee: null })).toEqual(["issue-3"])
    expect(await ids({ label: "label-bug" })).toEqual(["issue-1"])
    expect(await ids({ parent: "team-1", project: "project-1" })).toEqual(["issue-2", "issue-1"])
    expect((await store.tracker.issueByKey(account, "eng-2"))?.record.externalId).toBe("issue-2")

    const found = await store.tracker.find({ words: ["invoic"], accounts: [account] })
    expect(found.items.map((one) => one.item.record.externalId).sort()).toEqual(["issue-1", "project-1"])
    expect((await store.tracker.find({ words: ["accounts"], kinds: ["comment"] })).items).toHaveLength(1)
  })

  it("keeps a field a later read leaves out", async () => {
    const store = await storeOf()
    await store.tracker.save(account, "issue", [{ externalId: "i", title: "One", description: "kept" }], 1)
    await store.tracker.save(account, "issue", [{ externalId: "i", title: "Two" }], 2)
    expect((await store.tracker.get(account, "issue", "i"))?.record).toEqual({
      externalId: "i",
      title: "Two",
      description: "kept",
    })
  })
})

describe("trackerIssueTask", () => {
  it("makes an issue the owner's task once, by its key, copying only the key", async () => {
    const store = await storeOf()
    await syncTracker(fakeTrackerSource({ rows: exampleTrackerRows() }), store, account, {
      now: Date.UTC(2026, 10, 17),
    })
    const first = await trackerIssueTask(store, account, "ENG-1")
    expect(first.created).toBe(true)
    expect(first.task).toMatchObject({
      source: "tracker:issue/issue-1",
      sourceKind: "tracker_issue",
      origin: "owner",
      title: "ENG-1",
    })
    expect(first.task.description).toBeUndefined()
    const again = await trackerIssueTask(store, account, "issue-1")
    expect(again).toMatchObject({ created: false, task: { id: first.task.id } })
    await expect(trackerIssueTask(store, account, "ENG-99")).rejects.toThrow(/no issue ENG-99/)
  })
})
