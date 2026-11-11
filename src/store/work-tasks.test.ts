import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import { createTaskService } from "../tasks/index.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "work-tasks-")), "messages.db")

const withProject = async () => {
  const path = fresh()
  const store = await openStore({ path })
  const project = await store.knowledge.addProject({ name: "Lighthouse", key: "LHT", type: "work" })
  const database = await openCache(path)
  database.exec("INSERT INTO persons (id, name, owner, created_at, updated_at) VALUES (21, 'Bob Sample', 0, 0, 0)")
  database.exec(
    "INSERT INTO accounts (id, provider, external_id, created_at, updated_at) VALUES (1, 'telegram', '100', 0, 0)",
  )
  database.close()
  return { path, store, project }
}

describe("tasks made in the store", () => {
  it("creates a bug in a project with its fields, and records each change as an event", async () => {
    const { store, project } = await withProject()
    const bug = await store.tasks.create(
      { project: "lht", title: "Export drops the last row", type: "bug", priority: 0.625, description: "Seen on CSV" },
      "owner",
    )
    expect(bug).toMatchObject({
      id: "LHT-1",
      ref: "task:LHT-1",
      project: project.ref,
      type: "bug",
      status: "open",
      priority: 0.625,
      priorityLabel: "high",
      description: "Seen on CSV",
      source: null,
    })

    const sub = await store.tasks.create(
      { project: project.ref, title: "Add a test", type: "chore", parent: bug.ref },
      {
        bot: "planner",
      },
    )
    expect(sub.parent).toBe("task:LHT-1")
    await store.tasks.assign(bug.id, { to: "person:21", role: "assignee" }, "owner")
    await store.tasks.assign(bug.id, { to: "person:21", role: "assignee" }, "owner")
    await store.tasks.edit(bug.id, { priority: 0.875, dueAt: new Date("2026-10-20T00:00:00Z") }, "owner")
    const done = await store.tasks.edit(bug.id, { status: "done", reason: "fixed" }, "owner")

    expect(done).toMatchObject({
      status: "done",
      reason: "fixed",
      assignments: [{ to: "person:21", role: "assignee" }],
    })
    expect(done.closedAt).not.toBeNull()
    expect((await store.tasks.events(bug.id)).map((event) => [event.kind, event.changes])).toEqual([
      ["created", null],
      ["priority", { priority: [null, 0.625] }],
      ["assigned", { assignee: [null, "person:21"] }],
      ["priority", { priority: [0.625, 0.875] }],
      ["due", { due_at: [null, "2026-10-20T00:00:00.000Z"] }],
      ["status", { status: ["open", "done"] }],
    ])
    expect((await store.tasks.find({ project: "LHT", type: "bug" })).items.map((task) => task.id)).toEqual(["LHT-1"])
    expect((await store.tasks.find({ assignee: "person:21" })).items.map((task) => task.id)).toEqual(["LHT-1"])
    await store.close()
  })

  it("refuses a message kind, a bad priority, a parent elsewhere and a cycle", async () => {
    const { store } = await withProject()
    await store.knowledge.addProject({ name: "Other", key: "OTH" })
    const top = await store.tasks.create({ project: "LHT", title: "Top", type: "feature" }, "owner")
    const child = await store.tasks.create({ project: "LHT", title: "Child", type: "chore", parent: top.id }, "owner")
    const elsewhere = await store.tasks.create({ project: "OTH", title: "Else", type: "chore" }, "owner")

    await expect(
      store.tasks.create({ project: "LHT", title: "Q", type: "question" as never }, "owner"),
    ).rejects.toMatchObject({ code: "validation_error" })
    await expect(store.tasks.edit(top.id, { priority: 7 }, "owner")).rejects.toMatchObject({ code: "validation_error" })
    await expect(store.tasks.edit(top.id, { parent: elsewhere.id }, "owner")).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(store.tasks.edit(top.id, { parent: child.id }, "owner")).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(store.tasks.create({ project: "NOPE", title: "x", type: "bug" }, "owner")).rejects.toMatchObject({
      code: "not_found",
    })
    await store.close()
  })

  it("stays out of the task package's reads, while message tasks get fields and events too", async () => {
    const { store } = await withProject()
    const bug = await store.tasks.create({ project: "LHT", title: "Crash", type: "bug" }, "owner")
    const service = createTaskService({ store: store.tasks, newId: () => "t1" })
    const { task } = await service.add({
      source: "msg:telegram:100:-1001:42",
      sourceKind: "message",
      account: "telegram:100",
      group: "-1001",
      kind: "question",
      origin: "rule",
    })

    expect(await store.tasks.get(bug.id)).toBeUndefined()
    expect((await store.tasks.list({})).map((listed) => listed.id)).toEqual(["t1"])
    await service.close(task.id, { as: "done", by: "owner" })
    expect(await store.tasks.edit(task.id, { priority: 0.375, title: "Answer Bob Sample" }, "owner")).toMatchObject({
      id: "t1",
      type: "question",
      priority: 0.375,
      title: "Answer Bob Sample",
      source: "msg:telegram:100:-1001:42",
    })
    expect((await store.tasks.events(task.id)).map((event) => event.kind)).toEqual([
      "created",
      "status",
      "title",
      "priority",
    ])
    await store.close()
  })
})

describe("a task found in a message", () => {
  const found = async () => {
    const setup = await withProject()
    const service = createTaskService({ store: setup.store.tasks, newId: () => "t1" })
    const input = {
      source: "msg:telegram:100:-1001:42",
      sourceKind: "message",
      account: "telegram:100",
      group: "-1001",
      kind: "question" as const,
      origin: "rule" as const,
    }
    const { task } = await service.add(input)
    return { ...setup, service, input, task }
  }

  it("takes todo, in_progress and another message kind, stays in its account's reads, and joins the board", async () => {
    const { store, task } = await found()
    const doing = await store.tasks.edit(task.id, { status: "in_progress", type: "request" }, "owner")
    expect(doing).toMatchObject({ status: "in_progress", type: "request", key: "Q-1" })
    expect(await store.tasks.get(task.id)).toMatchObject({ state: "in_progress", kind: "request" })
    const open = await store.knowledge.taskIds({ provider: "telegram", account: "100" }, { state: "open" })
    expect(open.items).toEqual(["t1"])
    await expect(store.tasks.edit(task.id, { type: "bug" }, "owner")).rejects.toThrow("question, request")

    await store.tasks.assign(task.id, { to: "person:21", role: "assignee" }, "owner")
    const board = await store.tasks.board(parseLucene("assignee:person:21"), { limit: 10 })
    expect(board.items.map(({ key }) => key)).toEqual(["Q-1"])
    const counts = await store.tasks.boardCounts(undefined)
    expect(counts.state.find(({ value }) => value === "in_progress")?.count).toBe(1)
    expect(counts.project.map(({ value }) => value)).toEqual([])
    expect((await store.tasks.board(parseLucene("project:*"), { limit: 10 })).total).toBe(0)
    await store.close()
  })

  it("moves into a project under a new key, keeps its id and source, and a rule does not find it again", async () => {
    const { store, service, input, task } = await found()
    const moved = await store.tasks.edit(task.id, { project: "LHT", type: "bug" }, "owner")
    expect(moved).toMatchObject({
      id: "t1",
      key: "LHT-1",
      projectKey: "LHT",
      type: "bug",
      source: "msg:telegram:100:-1001:42",
    })
    expect((await store.tasks.details("Q-1")).key).toBe("LHT-1")
    expect(await store.tasks.get(task.id)).toBeUndefined()
    expect(await store.knowledge.taskIds({ provider: "telegram", account: "100" })).toMatchObject({ items: [] })
    expect(await service.add(input)).toMatchObject({ created: false, task: { id: "t1", kind: "question" } })
    expect(await store.tasks.list({})).toEqual([])
    await store.close()
  })
})
