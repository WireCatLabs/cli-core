import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const query = (text: string) => parseLucene(text, { defaultField: "text" })

const board = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "task-board-")), "messages.db")
  const store = await openStore({ path })
  await store.knowledge.addProject({ name: "Harbour launch", key: "HRB", type: "work" })
  await store.knowledge.addProject({ name: "Operations", key: "OPS", type: "work" })
  const database = await openCache(path)
  database.exec(
    "INSERT INTO persons (id, name, owner, created_at, updated_at) VALUES (21, 'Ana Ruiz', 0, 0, 0), (22, 'Kai Sample', 0, 0, 0)",
  )
  database.close()
  const add = (project: string, title: string, more: { priority?: number; dueAt?: Date; description?: string } = {}) =>
    store.tasks.create({ project, title, type: "chore", ...more }, "owner")
  const keys = (page: { items: { key: string }[] }) => page.items.map(({ key }) => key)
  return { store, add, keys }
}

describe("a task's work states", () => {
  it("moves through todo and in_progress without closing, and reopens a closed task", async () => {
    const { store, add } = await board()
    const task = await add("HRB", "Write the press note")
    await store.tasks.claim(task.id, "claude-code:1", new Date(Date.now() + 60_000))

    const doing = await store.tasks.edit(task.id, { status: "in_progress" }, "owner")
    expect(doing).toMatchObject({ status: "in_progress", closedAt: null, claimedBy: "claude-code:1" })

    await store.tasks.edit(task.id, { status: "dismissed", reason: "not needed" }, "owner")
    const reopened = await store.tasks.edit(task.id, { status: "todo" }, "owner")
    expect(reopened).toMatchObject({ status: "todo", closedAt: null, reason: null })
    expect(
      (await store.tasks.events(task.id)).filter(({ kind }) => kind === "status").map(({ changes }) => changes),
    ).toEqual([
      { status: ["open", "in_progress"] },
      { status: ["in_progress", "dismissed"] },
      { status: ["dismissed", "todo"] },
    ])
  })

  it("counts todo and in_progress as open work for readiness and claims", async () => {
    const { store, add } = await board()
    const blocker = await add("HRB", "Pick the venue")
    const task = await add("HRB", "Book the venue")
    await store.tasks.linkTask(task.id, blocker.id, "blocked-by", "owner")
    await store.tasks.edit(blocker.id, { status: "in_progress" }, "owner")
    await store.tasks.edit(task.id, { status: "todo" }, "owner")

    expect(await store.tasks.taskReadiness(task.id)).toMatchObject({ ready: false })
    await store.tasks.edit(blocker.id, { status: "done" }, "owner")
    expect(await store.tasks.taskReadiness(task.id)).toEqual({ ready: true, blockers: [] })
    expect((await store.tasks.readyTasks("HRB")).items.map(({ key }) => key)).toEqual(["HRB-2"])
    await expect(store.tasks.claim(task.id, "hermes", new Date(Date.now() + 60_000))).resolves.toMatchObject({
      claimedBy: "hermes",
    })
  })
})

describe("the task board", () => {
  it("lists every owner project, narrowed by fields, OR within a field, and words", async () => {
    const { store, add, keys } = await board()
    const invoice = await add("HRB", "Send the invoice", { priority: 0.875, description: "to the harbour office" })
    await add("HRB", "Print badges", { priority: 0.1875 })
    const ops = await add("OPS", "Renew the domain", { dueAt: new Date("2020-01-01T00:00:00Z") })
    await store.tasks.assign(invoice.id, { to: "person:21", role: "assignee" }, "owner")
    await store.tasks.assign(ops.id, { to: "person:22", role: "assignee" }, "owner")
    await store.tasks.edit(ops.id, { status: "in_progress" }, "owner")
    const list = async (text: string) => keys(await store.tasks.board(query(text), { limit: 50 }))

    expect(await list("project:*")).toEqual(["HRB-1", "HRB-2", "OPS-1"])
    expect(await list('assignee:("person:21" OR 22)')).toEqual(["HRB-1", "OPS-1"])
    expect(await list("assignee:none")).toEqual(["HRB-2"])
    expect(await list("priority:critical")).toEqual(["HRB-1"])
    expect(await list("priority:[low TO medium]")).toEqual(["HRB-2"])
    expect(await list("priority:[0.8 TO 1]")).toEqual(["HRB-1"])
    expect(await list("NOT priority:*")).toEqual(["OPS-1"])
    expect(await list("overdue:true")).toEqual(["OPS-1"])
    expect(await list("state:(todo OR in_progress)")).toEqual(["OPS-1"])
    expect(await list("harb")).toEqual(["HRB-1"])
    expect(await list("ops-1")).toEqual(["OPS-1"])
    expect(await list("project:OPS")).toEqual(["OPS-1"])
  })

  it("sorts by the chosen field, pages by offset and totals every page", async () => {
    const { store, add, keys } = await board()
    await add("HRB", "A", { priority: 0.375, dueAt: new Date("2026-12-01T00:00:00Z") })
    await add("HRB", "B", { priority: 0.625 })
    await add("OPS", "C", { priority: 0.0625, dueAt: new Date("2026-11-01T00:00:00Z") })

    expect(keys(await store.tasks.board(undefined, { limit: 10 }))).toEqual(["HRB-2", "HRB-1", "OPS-1"])
    expect(keys(await store.tasks.board(undefined, { limit: 10, sort: "due" }))).toEqual(["OPS-1", "HRB-1", "HRB-2"])
    expect(keys(await store.tasks.board(undefined, { limit: 10, sort: "key", descending: true }))).toEqual([
      "OPS-1",
      "HRB-2",
      "HRB-1",
    ])
    const second = await store.tasks.board(undefined, { limit: 2, offset: 2 })
    expect({ keys: keys(second), total: second.total }).toEqual({ keys: ["OPS-1"], total: 3 })
    await expect(store.tasks.board(undefined, { limit: 501 })).rejects.toThrow("1–500")
  })

  it("counts each picker's values without that picker's own terms", async () => {
    const { store, add } = await board()
    const a = await add("HRB", "A", { priority: 0.875 })
    await add("HRB", "B")
    const c = await add("OPS", "C", { priority: 0.875 })
    await store.tasks.assign(a.id, { to: "person:21", role: "assignee" }, "owner")
    await store.tasks.edit(c.id, { status: "done" }, "owner")

    const counts = await store.tasks.boardCounts(query("project:HRB state:open"))
    expect(counts.total).toBe(2)
    expect(counts.project).toEqual([{ value: "HRB", name: "Harbour launch", count: 2 }])
    expect(counts.state).toEqual([
      { value: "open", count: 2 },
      { value: "todo", count: 0 },
      { value: "in_progress", count: 0 },
      { value: "done", count: 0 },
      { value: "dismissed", count: 0 },
    ])
    expect(counts.assignee).toEqual([
      { value: "none", name: null, count: 1 },
      { value: "person:21", name: "Ana Ruiz", count: 1 },
    ])
    expect(counts.priority).toEqual([
      { value: "critical", count: 1 },
      { value: "high", count: 0 },
      { value: "medium", count: 0 },
      { value: "low", count: 0 },
      { value: "none", count: 1 },
    ])
  })

  it("offers the owner and everyone who holds a role on a task", async () => {
    const { store, add } = await board()
    const task = await add("HRB", "A")
    await store.tasks.assign(task.id, { to: "person:22", role: "reviewer" }, "owner")
    const people = await store.tasks.taskPeople()
    expect(people.find(({ owner }) => owner)).toMatchObject({ tasks: 0 })
    expect(people.filter(({ owner }) => !owner)).toEqual([
      { person: "person:22", name: "Kai Sample", owner: false, tasks: 1 },
    ])
  })

  it("refuses a write made on a stale revision, and records claims in the history", async () => {
    const { store, add } = await board()
    const task = await add("HRB", "A")
    await store.tasks.claim(task.id, "hermes", new Date(Date.now() + 60_000))
    await expect(store.tasks.edit(task.id, { title: "B" }, "owner", { revision: task.revision })).rejects.toMatchObject(
      {
        code: "configuration_error",
        details: { reason: "task.stale", revision: task.revision + 1 },
      },
    )
    await expect(
      store.tasks.assign(task.id, { to: "person:21", role: "assignee" }, "owner", { revision: task.revision }),
    ).rejects.toMatchObject({ details: { reason: "task.stale" } })
    const fresh = await store.tasks.details(task.id)
    const assigned = await store.tasks.assign(task.id, { to: "person:21", role: "assignee" }, "owner", fresh)
    expect(assigned.revision).toBe(fresh.revision + 1)
    await store.tasks.release(task.id, "hermes")
    const kinds = (await store.tasks.events(task.id)).map(({ kind }) => kind)
    expect(kinds).toEqual(["created", "claimed", "assigned", "released"])
  })

  it("keeps an agent apart from the assignees, and finds tasks by it", async () => {
    const { store, add, keys } = await board()
    const task = await add("HRB", "A")
    await add("HRB", "B")
    expect(await store.tasks.edit(task.id, { agent: "hermes" }, "owner")).toMatchObject({
      agent: "hermes",
      assignments: [],
    })
    expect(keys(await store.tasks.board(query("agent:Hermes"), { limit: 10 }))).toEqual(["HRB-1"])
    expect(keys(await store.tasks.board(query("agent:none"), { limit: 10 }))).toEqual(["HRB-2"])
    expect((await store.tasks.edit(task.id, { agent: null }, "owner")).agent).toBeNull()
  })

  it("moves a task between two others by priority, across a band edge, and into another column", async () => {
    const { store, add, keys } = await board()
    await add("HRB", "A", { priority: 0.875 })
    await add("HRB", "B", { priority: 0.6 })
    await add("OPS", "C", { priority: 0.3 })
    const column = async () => keys(await store.tasks.board(query("state:open"), { limit: 10 }))

    const up = await store.tasks.move("OPS-1", { before: "HRB-2" }, "owner")
    expect(up.label).toEqual({ from: "medium", to: "high", changed: true })
    expect(up.task.priority).toBeCloseTo(0.7375)
    expect(await column()).toEqual(["HRB-1", "OPS-1", "HRB-2"])

    const top = await store.tasks.move("HRB-2", { before: "HRB-1" }, "owner")
    expect(top.label).toEqual({ from: "high", to: "critical", changed: true })
    expect(await column()).toEqual(["HRB-2", "HRB-1", "OPS-1"])

    await add("HRB", "D")
    await store.tasks.move("OPS-1", { status: "in_progress" }, "owner")
    const doing = await store.tasks.move("HRB-3", { status: "in_progress", after: "OPS-1" }, "owner")
    expect(doing).toMatchObject({ renumbered: [], task: { status: "in_progress" } })
    await expect(store.tasks.move("HRB-1", { after: "HRB-3" }, "owner")).rejects.toThrow("is not a open task")
  })

  it("spreads a band out again when two neighbours leave no room", async () => {
    const { store, add, keys } = await board()
    await add("HRB", "A")
    await add("HRB", "B")
    await add("HRB", "C")
    const moved = await store.tasks.move("HRB-3", { before: "HRB-2" }, "owner")
    expect(moved.label).toEqual({ from: null, to: "low", changed: true })
    expect(moved.renumbered).toEqual(["HRB-1", "HRB-2"])
    expect(keys(await store.tasks.board(undefined, { limit: 10 }))).toEqual(["HRB-1", "HRB-3", "HRB-2"])
    const scores = (await store.tasks.board(undefined, { limit: 10 })).items.map(({ priority }) => priority)
    expect(scores).toEqual([0.1875, 0.125, 0.0625])
  })
})
