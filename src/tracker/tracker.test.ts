import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runBudget } from "../background/budget.js"
import { type MessageStore, openStore } from "../store/store.js"
import { createTaskService } from "../tasks/index.js"
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
    const source = fakeTrackerSource({ rows, self: "user-1" })
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
        trash: () => {
          source.trash("issue", "issue-3")
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
      ["team", "user", "state", "label", "project", "sprint", "issue", "comment"].map((kind) => [
        kind,
        "full",
        "complete",
      ]),
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
    expect(await store.tracker.count(account, "state")).toBe(7)
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

describe("syncTracker: sprints, trashed issues and what changed", () => {
  const now = Date.UTC(2026, 10, 17)

  it("copies sprints, titles an unnamed one by its number, and narrows issues by sprint", async () => {
    const store = await storeOf()
    await syncTracker(fakeTrackerSource({ rows: exampleTrackerRows() }), store, account, { now })
    const [sprint] = (await store.tracker.list(account, "sprint")).items
    expect(sprint?.record).toMatchObject({ externalId: "sprint-1", number: 1, team: "team-1" })
    const ids = async (sprint: string | null) =>
      (await store.tracker.list(account, "issue", { sprint })).items.map((one) => one.record.externalId).sort()
    expect(await ids("sprint-1")).toEqual(["issue-1"])
    expect(await ids(null)).toEqual(["issue-2", "issue-3"])
  })

  it("counts only the rows that changed, and says when it next looks for deletions", async () => {
    const store = await storeOf()
    const source = fakeTrackerSource({ rows: exampleTrackerRows() })
    const first = await syncTracker(source, store, account, { now })
    expect(first.progress.saved).toBe(first.synced.reduce((sum, one) => sum + one.saved, 0))
    expect(first.synced.find((one) => one.kind === "issue")?.saved).toBe(3)
    expect(first.deletions).toEqual({
      checked: new Date(now).toISOString(),
      due: new Date(now + 86_400_000).toISOString(),
    })

    const again = await syncTracker(source, store, account, { now: now + 60_000, rescan: true })
    expect(again.synced.every((one) => one.saved === 0)).toBe(true)
    expect(again.progress.saved).toBe(0)
  })

  it("marks a trashed issue deleted with its comments at the id pass, and keeps it so on a full list", async () => {
    const store = await storeOf()
    const rows = exampleTrackerRows()
    const source = fakeTrackerSource({ rows })
    await syncTracker(source, store, account, { now })
    source.trash("issue", "issue-1")

    const plain = await syncTracker(source, store, account, { now: now + 60_000 })
    expect(plain.synced.find((one) => one.kind === "issue")).toMatchObject({ round: "changes", saved: 0 })
    expect((await store.tracker.get(account, "issue", "issue-1"))?.deletedAt).toBeNull()

    const passed = await syncTracker(source, store, account, { now: now + 2 * 86_400_000 })
    expect(passed.synced.find((one) => one.kind === "issue")).toMatchObject({ pass: "complete", unlisted: 1 })
    expect((await store.tracker.get(account, "issue", "issue-1"))?.deletedAt).toEqual(expect.any(Number))
    expect((await store.tracker.get(account, "comment", "comment-1"))?.deletedAt).toEqual(expect.any(Number))
    expect((await store.tracker.find({ words: ["accounts"], accounts: [account] })).items).toEqual([])

    const rescan = await syncTracker(source, store, account, { now: now + 3 * 86_400_000, rescan: true })
    expect(rescan.synced.find((one) => one.kind === "issue")?.saved).toBe(1)
    expect((await store.tracker.get(account, "issue", "issue-1"))?.deletedAt).toEqual(expect.any(Number))
    expect((await store.tracker.get(account, "comment", "comment-1"))?.deletedAt).toEqual(expect.any(Number))

    const issue = rows.issue.find((one) => one.externalId === "issue-1") as (typeof rows.issue)[number]
    Object.assign(issue, { deleted: null, archivedAt: null })
    await syncTracker(source, store, account, { now: now + 4 * 86_400_000, rescan: true })
    expect((await store.tracker.get(account, "issue", "issue-1"))?.deletedAt).toBeNull()
    expect((await store.tracker.get(account, "comment", "comment-1"))?.deletedAt).toBeNull()
  })

  it("marks a row read as deleted at once, and takes the issue's comments with it", async () => {
    const store = await storeOf()
    const rows = exampleTrackerRows()
    await syncTracker(fakeTrackerSource({ rows }), store, account, { now })
    const [issue] = rows.issue
    expect(
      await store.tracker.save(account, "issue", [{ ...(issue as (typeof rows.issue)[number]), deleted: true }], now),
    ).toBe(1)
    expect((await store.tracker.get(account, "issue", "issue-1"))?.deletedAt).toBe(now)
    expect((await store.tracker.get(account, "comment", "comment-1"))?.deletedAt).toBe(now)
    expect(await store.tracker.save(account, "comment", rows.comment, now + 1)).toBe(0)
    expect((await store.tracker.get(account, "comment", "comment-1"))?.deletedAt).toBe(now)
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
    const refused = await syncTracker(gapped, store, account, { now: T + 3 * DAYS, rescan: true })
    expect(refused.synced.find((one) => one.kind === "comment")?.pass).toBe("held")
    expect(await store.tracker.count(account, "comment")).toBe(1)

    const through = await syncTracker(emptied, store, account, { now: T + 4 * DAYS, rescan: true })
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
  it("makes an issue the owner's task once, by its key, titled by its key and title", async () => {
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
      title: "ENG-1 Invoices fail for EUR accounts",
    })
    expect(first.task.description).toBeUndefined()
    const again = await trackerIssueTask(store, account, "issue-1")
    expect(again).toMatchObject({ created: false, task: { id: first.task.id } })
    await expect(trackerIssueTask(store, account, "ENG-99")).rejects.toThrow(/no issue ENG-99/)
  })
})

describe("syncTracker and the owner's tasks", () => {
  const T = Date.UTC(2026, 10, 17)
  const setup = async (options: { self?: string } = { self: "user-1" }) => {
    const store = await storeOf()
    const rows = exampleTrackerRows()
    const source = fakeTrackerSource({ rows, ...options })
    let at = T
    const sync = async () => {
      at += 60_000
      return (await syncTracker(source, store, account, { now: at, passEvery: 0 })).tasks
    }
    const issue = (id: string) => rows.issue.find((one) => one.externalId === id) as (typeof rows.issue)[number]
    const change = (id: string, patch: Partial<(typeof rows.issue)[number]>) => {
      Object.assign(issue(id), patch)
      source.touch("issue", id)
    }
    const tasks = async () =>
      (await store.tasks.query("fake-tracker:workspace", undefined, { limit: 50, offset: 0 })).map((one) => ({
        source: one.task.source,
        title: one.title,
        state: one.task.state,
        origin: one.task.origin,
        ...(one.task.reason ? { reason: one.task.reason } : {}),
      }))
    return { store, source, sync, change, tasks }
  }

  it("makes each open issue assigned to the signed-in user a task once, titled by its key and title", async () => {
    const { sync, tasks } = await setup()
    expect(await sync()).toEqual({ opened: 1, closed: 0, reopened: 0, renamed: 0 })
    expect(await tasks()).toEqual([
      {
        source: "tracker:issue/issue-1",
        title: "ENG-1 Invoices fail for EUR accounts",
        state: "open",
        origin: "rule",
      },
    ])
    expect(await sync()).toEqual({ opened: 0, closed: 0, reopened: 0, renamed: 0 })
    expect(await tasks()).toHaveLength(1)
  })

  it("keeps the title current and answers the same task to issues assign", async () => {
    const { store, sync, change, tasks } = await setup()
    await sync()
    change("issue-1", { title: "Invoices fail for EUR and GBP" })
    expect(await sync()).toMatchObject({ renamed: 1 })
    expect((await tasks())[0]?.title).toBe("ENG-1 Invoices fail for EUR and GBP")
    expect(await trackerIssueTask(store, account, "ENG-1")).toMatchObject({ created: false })
    expect(await tasks()).toHaveLength(1)
  })

  it("closes the task when the issue is completed, canceled or reassigned, and reopens the same task", async () => {
    const { sync, change, tasks } = await setup()
    await sync()
    change("issue-1", { state: "state-done" })
    expect(await sync()).toMatchObject({ closed: 1 })
    expect(await tasks()).toMatchObject([{ state: "done", reason: "the issue was completed in fake-tracker" }])
    change("issue-1", { state: "state-doing" })
    expect(await sync()).toMatchObject({ opened: 0, reopened: 1 })
    expect(await tasks()).toEqual([expect.objectContaining({ state: "open" })])
    expect((await tasks())[0]).not.toHaveProperty("reason")

    change("issue-1", { state: "state-twin" })
    await sync()
    expect(await tasks()).toMatchObject([
      { state: "dismissed", reason: "the issue was marked a duplicate in fake-tracker" },
    ])
    change("issue-1", { state: "state-doing" })
    expect(await sync()).toMatchObject({ reopened: 1 })

    change("issue-1", { state: "state-gone" })
    await sync()
    expect(await tasks()).toMatchObject([{ state: "dismissed", reason: "the issue was canceled in fake-tracker" }])
    change("issue-1", { state: "state-todo", assignee: "user-2" })
    expect(await sync()).toMatchObject({ reopened: 0 })
    expect(await tasks()).toMatchObject([{ state: "dismissed" }])

    change("issue-1", { assignee: "user-1" })
    expect(await sync()).toMatchObject({ reopened: 1 })
    change("issue-1", { assignee: "user-2" })
    expect(await sync()).toMatchObject({ closed: 1 })
    expect(await tasks()).toMatchObject([
      { state: "dismissed", reason: "the issue was assigned to someone else in fake-tracker" },
    ])
    change("issue-1", { assignee: "user-1" })
    await sync()
    expect(await tasks()).toEqual([expect.objectContaining({ state: "open", origin: "rule" })])
  })

  it("reopens nothing on a state the copy lacks, and leaves a task the owner opened again", async () => {
    const { store, sync, change, tasks } = await setup()
    await sync()
    change("issue-1", { state: "state-done" })
    await sync()
    change("issue-1", { state: "state-new" })
    expect(await sync()).toMatchObject({ reopened: 0 })
    expect(await tasks()).toMatchObject([{ state: "done" }])

    const [task] = await store.tasks.query("fake-tracker:workspace", undefined, { limit: 1, offset: 0 })
    await store.tasks.edit(task?.task.id as string, { status: "open" }, "owner")
    expect(await sync()).toMatchObject({ closed: 0 })
    expect(await tasks()).toMatchObject([{ state: "open" }])
  })

  it("keeps the owner's reopen past the owner's next change, and closes again after the issue was open work", async () => {
    const { store, sync, change, tasks } = await setup()
    await sync()
    const [task] = await store.tasks.query("fake-tracker:workspace", undefined, { limit: 1, offset: 0 })
    const id = task?.task.id as string
    change("issue-1", { state: "state-done" })
    await sync()
    await store.tasks.edit(id, { status: "open" }, "owner")
    await store.tasks.edit(id, { title: "Invoices, my words" }, "owner")
    await store.tasks.edit(id, { status: "in_progress" }, "owner")
    expect(await sync()).toMatchObject({ closed: 0 })
    expect(await tasks()).toMatchObject([{ state: "in_progress" }])

    change("issue-1", { state: "state-doing" })
    expect(await sync()).toMatchObject({ closed: 0, reopened: 0 })
    change("issue-1", { state: "state-done" })
    expect(await sync()).toMatchObject({ closed: 1 })
    expect(await tasks()).toMatchObject([{ state: "done" }])
    change("issue-1", { state: "state-doing" })
    expect(await sync()).toMatchObject({ reopened: 1 })
    expect(await tasks()).toMatchObject([{ state: "in_progress" }])
  })

  it("opens a task the sync closed as reassigned when the owner picks the issue, and keeps it open", async () => {
    const { store, sync, change, tasks } = await setup()
    await sync()
    change("issue-1", { assignee: "user-2" })
    await sync()
    expect(await tasks()).toMatchObject([{ state: "dismissed" }])
    const picked = await trackerIssueTask(store, account, "ENG-1")
    expect(picked).toMatchObject({ created: false, task: { state: "open" } })
    expect(await sync()).toMatchObject({ closed: 0 })
    change("issue-1", { assignee: "user-3" })
    expect(await sync()).toMatchObject({ closed: 0 })
    expect(await tasks()).toMatchObject([{ state: "open" }])
  })

  it("keeps a task the owner closed and then picked, whoever holds the issue", async () => {
    const { store, sync, change, tasks } = await setup()
    await sync()
    const [task] = await store.tasks.query("fake-tracker:workspace", undefined, { limit: 1, offset: 0 })
    await createTaskService({ store: store.tasks }).close(task?.task.id as string, { as: "dismissed", by: "owner" })
    change("issue-1", { assignee: "user-2" })
    await sync()
    expect(await trackerIssueTask(store, account, "ENG-1")).toMatchObject({ task: { state: "open" } })
    expect(await sync()).toMatchObject({ closed: 0 })
    expect(await tasks()).toMatchObject([{ state: "open" }])
  })

  it("closes a reopened task once the issue was open work, though it went to someone else in between", async () => {
    const { store, sync, change, tasks } = await setup()
    await sync()
    const [task] = await store.tasks.query("fake-tracker:workspace", undefined, { limit: 1, offset: 0 })
    change("issue-1", { state: "state-done" })
    await sync()
    await store.tasks.edit(task?.task.id as string, { status: "open" }, "owner")
    change("issue-1", { state: "state-doing" })
    await sync()
    change("issue-1", { assignee: "user-2" })
    expect(await sync()).toMatchObject({ closed: 0 })
    change("issue-1", { assignee: "user-1", state: "state-done" })
    expect(await sync()).toMatchObject({ closed: 1 })
    expect(await tasks()).toMatchObject([{ state: "done" }])
  })

  it("takes only its own close for one the owner can overrule: an agent's close is not the sync's", async () => {
    const { store, sync, change, tasks } = await setup()
    await sync()
    const [task] = await store.tasks.query("fake-tracker:workspace", undefined, { limit: 1, offset: 0 })
    const id = task?.task.id as string
    await store.tasks.edit(id, { status: "done" }, { bot: "claude-code", kind: "agent" })
    await store.tasks.edit(id, { status: "open" }, "owner")
    change("issue-1", { state: "state-done" })
    expect(await sync()).toMatchObject({ closed: 1 })
    expect(await tasks()).toMatchObject([{ state: "done" }])
  })

  it("says an issue left with no one was unassigned, and keeps a title of odd spaces stable", async () => {
    const { sync, change, tasks } = await setup()
    await sync()
    change("issue-1", { title: "  Fix   login ", assignee: null })
    expect(await sync()).toMatchObject({ closed: 1, renamed: 1 })
    expect(await tasks()).toMatchObject([
      { title: "ENG-1 Fix login", reason: "the issue was unassigned in fake-tracker" },
    ])
    expect(await sync()).toMatchObject({ renamed: 0 })
  })

  it("closes the task of an issue deleted outright", async () => {
    const { source, sync, tasks } = await setup()
    await sync()
    source.remove("issue", "issue-1")
    expect(await sync()).toMatchObject({ closed: 1 })
    expect(await tasks()).toMatchObject([{ state: "dismissed", reason: "the issue was deleted in fake-tracker" }])
  })

  it("keeps a task the owner picked whoever holds the issue, and one the owner closed stays closed", async () => {
    const { store, sync, change, tasks } = await setup()
    await sync()
    await trackerIssueTask(store, account, "ENG-2")
    const [first] = await store.tasks.query("fake-tracker:workspace", undefined, { limit: 1, offset: 0 })
    await createTaskService({ store: store.tasks }).close(first?.task.id as string, { as: "dismissed", by: "owner" })
    const other = await createTaskService({ store: store.tasks }).add({
      source: "note:1",
      sourceKind: "note",
      account: "fake-tracker:workspace",
      group: "note:1",
      kind: "request",
      origin: "owner",
      title: "Call the bank",
    })

    expect(await sync()).toEqual({ opened: 0, closed: 0, reopened: 0, renamed: 0 })
    expect((await tasks()).map((one) => [one.source, one.state])).toEqual([
      ["tracker:issue/issue-1", "dismissed"],
      ["tracker:issue/issue-2", "open"],
      ["note:1", "open"],
    ])
    change("issue-2", { state: "state-done" })
    expect(await sync()).toMatchObject({ closed: 1 })
    expect((await store.tasks.get(other.task.id))?.state).toBe("open")
  })

  it("leaves tasks alone when the tracker cannot name its user", async () => {
    const { sync, tasks } = await setup({})
    expect(await sync()).toBeUndefined()
    expect(await tasks()).toEqual([])
  })

  it("asks the tracker for its user once, and says why it skipped when the budget is spent", async () => {
    const store = await storeOf()
    let asked = 0
    const source = { ...fakeTrackerSource({ rows: exampleTrackerRows() }), self: async () => `user-${++asked}` }
    expect((await syncTracker(source, store, account, { now: T })).tasks).toMatchObject({ opened: 1 })
    await syncTracker(source, store, account, { now: T + 1 })
    expect(asked).toBe(1)

    const fresh = await storeOf()
    const report = await syncTracker(source, fresh, account, { now: T, budget: runBudget({ requests: 1 }) })
    expect(report.tasks).toMatchObject({ skipped: expect.stringMatching(/budget was spent/) })
  })
})

describe("store.tracker.find", () => {
  it("finds the forms of a word among thousands of rows that share its first letters", async () => {
    const store = await storeOf()
    const starting = [1, 2, 3].map((at) => ({ externalId: `f${at}`, title: `Starting fails ${at}` }))
    const stable = Array.from({ length: 2_100 }, (_, at) => ({ externalId: `s${at}`, title: `Stable build ${at}` }))
    await store.tracker.save(account, "issue", [...starting, ...stable], 1)
    for (const anyWord of [false, true]) {
      const found = await store.tracker.find({ words: ["started"], anyWord, accounts: [account], limit: 10 })
      expect(found.items.map(({ item }) => item.record.externalId).sort()).toEqual(["f1", "f2", "f3"])
      expect(found).toMatchObject({ hasMore: false })
      expect(found.capped).toBeUndefined()
    }
  })

  it("says it read only the first rows the index offered when more held the word's beginning", async () => {
    const store = await storeOf()
    const bridges = [1, 2, 3].map((at) => ({ externalId: `b${at}`, title: `Construction of the bridge ${at}` }))
    const others = Array.from({ length: 2_100 }, (_, at) => ({ externalId: `c${at}`, title: `Constructor ${at}` }))
    await store.tracker.save(account, "issue", [...bridges, ...others], 1)
    for (const anyWord of [false, true]) {
      const found = await store.tracker.find({ words: ["constructions"], anyWord, accounts: [account], limit: 10 })
      expect(found.capped).toBe(true)
      expect(found.hasMore).toBe(found.items.length > 0)
    }
  })
})
