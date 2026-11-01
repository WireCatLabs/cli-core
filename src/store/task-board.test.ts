import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dayBoundary, parseLucene, timezoneOf } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import { listQuery } from "../cli/list-query.js"
import { priorityOf } from "../tasks/index.js"
import { openCache } from "./open.js"
import { PROJECT_TASK_FIELDS } from "./sqlite/task-board.js"
import { openStore } from "./store.js"

const query = (text: string) => parseLucene(text, { defaultField: "text" })

const dayStart = (zone: string, at: number, ahead: number) => {
  const date = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + ahead)
  return dayBoundary(date.toISOString().slice(0, 10), zone, false, { start: 0, end: 0 })
}

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
  return { store, add, keys, path }
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
    expect(counts.project).toEqual([{ value: "HRB", ref: "project:1", name: "Harbour launch", count: 2 }])
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

  it("offers everyone the store knows: the owner first, then by their tasks, a person added by name too", async () => {
    const { store, add } = await board()
    const task = await add("HRB", "A")
    await store.tasks.assign(task.id, { to: "person:22", role: "reviewer" }, "owner")
    const lena = await store.people.add({ name: "  Lena Example " })
    expect(lena).toMatchObject({ name: "Lena Example", identities: [] })
    await expect(store.people.add({ name: " " })).rejects.toThrow("1–200 characters")

    const people = await store.tasks.taskPeople()
    expect(people[0]).toMatchObject({ owner: true, tasks: 0 })
    expect(people.slice(1)).toEqual([
      { person: "person:22", name: "Kai Sample", owner: false, tasks: 1 },
      { person: "person:21", name: "Ana Ruiz", owner: false, tasks: 0 },
      { person: `person:${lena.uid}`, name: "Lena Example", owner: false, tasks: 0 },
    ])
    expect(await store.tasks.taskPeople({ limit: 2 })).toHaveLength(2)
  })

  it("adds a task with its state, due date and agent in one write, and clears its description", async () => {
    const { store } = await board()
    const due = new Date("2026-12-01T10:00:00Z")
    const task = await store.tasks.create(
      {
        project: "HRB",
        title: "Book the venue",
        type: "chore",
        status: "in_progress",
        dueAt: due,
        agent: "hermes",
        description: "Two rooms",
      },
      "owner",
    )
    expect(task).toMatchObject({
      status: "in_progress",
      dueAt: due.toISOString(),
      agent: "hermes",
      projectKey: "HRB",
      projectName: "Harbour launch",
    })
    expect(await store.tasks.edit(task.id, { description: null }, "owner")).toMatchObject({ description: null })
    const history = await store.tasks.events(task.id)
    expect(history.find(({ kind }) => kind === "due")?.changes).toEqual({ due_at: [null, due.toISOString()] })
  })

  it("moves a task to another project under a new key, and the old key still finds it", async () => {
    const { store, add } = await board()
    const task = await add("HRB", "Book the venue")
    const parent = await add("HRB", "Launch")
    const sub = await store.tasks.create({ project: "HRB", title: "Sub", type: "chore", parent: parent.id }, "owner")
    const moved = await store.tasks.edit(task.id, { project: "OPS" }, "owner", { revision: task.revision })
    expect(moved).toMatchObject({ key: "OPS-1", id: "OPS-1", ref: "task:OPS-1", projectKey: "OPS" })
    expect(moved.revision).toBeGreaterThan(task.revision)
    expect((await store.tasks.details("HRB-1")).key).toBe("OPS-1")
    expect((await store.tasks.events("OPS-1")).at(-1)).toMatchObject({
      kind: "project",
      changes: { project: ["project:1", "project:2"], key: ["HRB-1", "OPS-1"] },
    })
    expect((await add("HRB", "Next")).key).toBe("HRB-4")

    await expect(store.tasks.edit(parent.id, { project: "OPS" }, "owner")).rejects.toMatchObject({
      details: { reason: "task.has-subtasks", subtasks: [sub.key] },
    })
    expect(await store.tasks.edit(sub.id, { project: "OPS" }, "owner")).toMatchObject({ key: "OPS-2", parent: null })
  })

  it("changes a project task's kind within bug, feature and chore, and the revision moves", async () => {
    const { store, add } = await board()
    const task = await add("HRB", "Fix the form")
    const bug = await store.tasks.edit(task.id, { type: "bug" }, "owner")
    expect(bug).toMatchObject({ type: "bug" })
    expect(bug.revision).toBe(task.revision + 1)
    await expect(store.tasks.edit(task.id, { type: "question" as never }, "owner")).rejects.toThrow("bug, feature")
    expect((await store.tasks.events(task.id)).at(-1)).toMatchObject({
      kind: "type",
      changes: { type: ["chore", "bug"] },
    })
  })

  it("names who added a task, and keeps an agent's comment in the agent's name", async () => {
    const { store } = await board()
    const task = await store.tasks.create({ project: "HRB", title: "Book", type: "chore" }, { bot: "claude-desktop" })
    expect(task.createdBy).toMatchObject({ type: "bot", name: "claude-desktop", owner: false })
    expect(
      (await store.tasks.create({ project: "HRB", title: "Mine", type: "chore" }, "owner")).createdBy,
    ).toMatchObject({ type: "person", owner: true })

    await store.tasks.comment(task.id, "Asked for two rooms", { bot: "hermes" })
    const mine = await store.tasks.comment(task.id, "Fine by me", "owner")
    expect(mine).toMatchObject({ text: "Fine by me", author: { owner: true }, at: expect.any(String) })
    expect((await store.tasks.comments(task.id)).map(({ text, author }) => [text, author?.name ?? "owner"])).toEqual([
      ["Asked for two rooms", "hermes"],
      ["Fine by me", "owner"],
    ])
    expect((await store.tasks.details(task.id)).revision).toBe(task.revision)
    await expect(store.tasks.comment(task.id, " ", "owner")).rejects.toThrow("a comment")
  })

  it("reads tomorrow in due: as the next calendar day, through the list query", async () => {
    const { store, add } = await board()
    const zone = timezoneOf()
    const now = Date.now()
    await add("HRB", "Tomorrow noon", { dueAt: new Date(dayStart(zone, now, 1) + 12 * 3_600_000) })
    await add("HRB", "Today", { dueAt: new Date(dayStart(zone, now, 0) + 12 * 3_600_000) })
    const titles = async (text: string) =>
      (
        await store.tasks.board(
          listQuery(
            `project:HRB ${text}`,
            { entity: "task", backend: "sql", fields: PROJECT_TASK_FIELDS },
            "tasks list",
          ),
          {
            zone,
            limit: 50,
          },
        )
      ).items
        .map(({ title }) => title)
        .sort()
    expect(await titles("due:tomorrow")).toEqual(["Tomorrow noon"])
    expect(await titles("due:[today TO tomorrow]")).toEqual(["Today", "Tomorrow noon"])
  })

  it("reads a score with a decimal point as 0–1, and a bare 0–4 as the old scale", () => {
    expect(priorityOf("0.0")).toBe(0)
    expect(priorityOf("1.0")).toBe(1)
    expect(priorityOf(".3")).toBe(0.3)
    expect(priorityOf("0")).toBe(0.875)
    expect(priorityOf("1")).toBe(0.625)
    expect(() => priorityOf("1.5")).toThrow("0.0 to 1.0")
  })

  it("groups due dates by the owner's day: overdue before today, today, the next 7 days, later and none", async () => {
    const { store, add } = await board()
    const zone = "Europe/Madrid"
    const now = Date.now()
    const madrid = (offsetDays: number, hour: number) => new Date(dayStart(zone, now, offsetDays) + hour * 3_600_000)
    await add("HRB", "Yesterday", { dueAt: madrid(-1, 12) })
    await add("HRB", "Earlier today", { dueAt: madrid(0, 0) })
    await add("HRB", "Tonight", { dueAt: madrid(0, 23) })
    await add("HRB", "In three days", { dueAt: madrid(3, 9) })
    await add("HRB", "In a month", { dueAt: madrid(30, 9) })
    const none = await add("HRB", "No date")
    await store.tasks.edit(none.id, { agent: "hermes" }, "owner")

    const titles = async (text: string) =>
      (await store.tasks.board(query(`project:HRB ${text}`), { zone, limit: 50 })).items
        .map(({ title }) => title)
        .sort()
    expect(await titles("overdue:true")).toEqual(["Yesterday"])
    expect(await titles("when:today")).toEqual(["Earlier today", "Tonight"])
    expect(await titles("when:upcoming")).toEqual(["In three days"])
    expect(await titles("when:later")).toEqual(["In a month"])
    expect(await titles("when:none")).toEqual(["No date"])

    const counts = await store.tasks.boardCounts(query("project:HRB when:today"), { zone })
    expect(counts.total).toBe(2)
    expect(counts.due).toEqual([
      { value: "overdue", count: 1 },
      { value: "today", count: 2 },
      { value: "upcoming", count: 1 },
      { value: "later", count: 1 },
      { value: "none", count: 1 },
    ])
    const all = await store.tasks.boardCounts(query("project:HRB"), { zone })
    expect(all.agent).toEqual([
      { value: "none", count: 5 },
      { value: "hermes", count: 1 },
    ])
  })

  it("refuses a write made on a stale revision, and records claims in the history", async () => {
    const { store, add } = await board()
    const task = await add("HRB", "A")
    await store.tasks.claim(task.id, "hermes", new Date(Date.now() + 60_000))
    const titled = await store.tasks.edit(task.id, { title: "B" }, "owner", { revision: task.revision })
    expect(titled.revision).toBe(task.revision + 1)
    await expect(
      store.tasks.assign(task.id, { to: "person:21", role: "assignee" }, "owner", { revision: task.revision }),
    ).rejects.toMatchObject({
      code: "configuration_error",
      details: { reason: "task.stale", revision: titled.revision },
    })
    const assigned = await store.tasks.assign(task.id, { to: "person:21", role: "assignee" }, "owner", titled)
    expect(assigned.revision).toBe(titled.revision + 1)
    const unassigned = await store.tasks.unassign(task.id, { to: "person:21", role: "assignee" }, "owner", assigned)
    expect(unassigned.revision).toBe(assigned.revision + 1)
    await store.tasks.release(task.id, "hermes")
    const kinds = (await store.tasks.events(task.id)).map(({ kind }) => kind)
    expect(kinds).toEqual(["created", "claimed", "title", "assigned", "unassigned", "released"])
  })

  it("keeps the revision while an agent works: a claim, its renewal and release, a follow-up time", async () => {
    const { store, add, path } = await board()
    const task = await add("HRB", "A")
    const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000)
    await store.tasks.claim(task.id, "hermes", soon(1))
    await store.tasks.claim(task.id, "hermes", soon(5))
    await store.tasks.edit(task.id, { nextCheckAt: soon(60) }, { bot: "hermes" })
    await store.tasks.recordCloseCertainty(task.id, 0.4)
    await store.tasks.release(task.id, "hermes")
    expect((await store.tasks.details(task.id)).revision).toBe(task.revision)

    const database = await openCache(path)
    database.exec(`UPDATE tasks SET claimed_by = 'old-build', claimed_until = 1, updated_at = 2 WHERE key = 'HRB-1'`)
    database.exec(`UPDATE tasks SET status = status, title = title WHERE key = 'HRB-1'`)
    expect(database.prepare("SELECT revision FROM tasks WHERE key = 'HRB-1'").get()?.revision).toBe(task.revision)
    database.exec(`UPDATE tasks SET title = 'Renamed by an older build' WHERE key = 'HRB-1'`)
    expect(database.prepare("SELECT revision FROM tasks WHERE key = 'HRB-1'").get()?.revision).toBe(task.revision + 1)
    database.close()
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
  })

  it("moves a card beside one in another column into that column, and refuses a status that names another", async () => {
    const { store, add } = await board()
    await add("HRB", "A")
    await add("HRB", "B")
    await store.tasks.move("HRB-2", { status: "in_progress" }, "owner")

    const joined = await store.tasks.move("HRB-1", { after: "HRB-2" }, "owner")
    expect(joined).toMatchObject({ label: { from: null, to: "low", changed: true }, task: { status: "in_progress" } })
    expect(joined.task.revision).toBe(2)

    await store.tasks.move("HRB-1", { status: "done" }, "owner")
    await expect(store.tasks.move("HRB-1", { status: "todo", before: "HRB-2" }, "owner")).rejects.toMatchObject({
      code: "validation_error",
      message: "HRB-2 is in in_progress, not todo: pick a task in the todo column",
      details: { reason: "task.column", anchor: "HRB-2", anchorStatus: "in_progress", requestedStatus: "todo" },
    })
    await expect(store.tasks.move("HRB-1", { before: "HRB-1" }, "owner")).rejects.toThrow(
      "a task moves beside another task, not itself",
    )
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

  it("records a task's tags and close certainty in its history", async () => {
    const { store, add } = await board()
    const task = await add("HRB", "A")
    expect(await store.knowledge.addTags(null, { type: "task", id: task.id }, ["venue"])).toEqual(["venue"])
    await store.knowledge.removeTags(null, { type: "task", id: task.id }, ["venue"])
    await store.tasks.recordCloseCertainty(task.id, 0.8)
    const events = (await store.tasks.events(task.id)).map(({ kind, changes }) => [kind, changes])
    expect(events.slice(1)).toEqual([
      ["tags", { tags: [[], ["venue"]] }],
      ["tags", { tags: [["venue"], []] }],
      ["close-certainty", { close_certainty: [null, 0.8] }],
    ])
    expect((await store.tasks.details(task.id)).revision).toBe(task.revision + 2)
  })
})
