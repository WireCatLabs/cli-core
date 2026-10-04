import { describe, expect, it } from "vitest"
import { createTaskService, type NewTask, type Task, TaskError } from "./index.js"
import { memoryTaskStore } from "./testing/index.js"

const question: NewTask = {
  source: "msg:tg:chat-1:100",
  sourceKind: "message",
  account: "tg:owner",
  group: "chat-1",
  kind: "question",
  origin: "rule",
}

function setup(start = "2026-10-04T10:00:00Z") {
  let now = new Date(start)
  let ids = 0
  const service = createTaskService({ store: memoryTaskStore(), now: () => now, newId: () => `t${++ids}` })
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms)
  }
  return { service, advance }
}

describe("adding", () => {
  it("makes one task from the same source however often a rule sees it", async () => {
    const { service } = setup()
    const first = await service.add(question)
    const second = await service.add(question)

    expect(first.created).toBe(true)
    expect(second).toEqual({ task: first.task, created: false })
    expect(await service.list()).toHaveLength(1)
  })

  it("never reopens a dismissed task", async () => {
    const { service } = setup()
    const { task } = await service.add(question)
    await service.close(task.id, { as: "dismissed", by: "owner", reason: "no-reply-needed" })

    const again = await service.add(question)

    expect(again.created).toBe(false)
    expect(again.task).toMatchObject({ state: "dismissed", reason: "no-reply-needed", closedBy: "owner" })
  })

  it("gives each task its own id and the current time when none are injected", async () => {
    const service = createTaskService({ store: memoryTaskStore() })
    const before = Date.now()
    const a = await service.add(question)
    const b = await service.add({ ...question, source: "msg:other" })

    expect(a.task.id).not.toBe(b.task.id)
    expect(a.task.createdAt.getTime()).toBeGreaterThanOrEqual(before)
  })

  it("adds a hand-made task of another kind beside a closed one, but not a second of the same kind", async () => {
    const { service } = setup()
    const { task } = await service.add(question)
    await service.close(task.id, { as: "dismissed", by: "owner", reason: "no-reply-needed" })

    const promise = await service.add({ ...question, kind: "promise", origin: "owner" })
    const again = await service.add({ ...question, kind: "promise", origin: "agent" })
    const fromRule = await service.add({ ...question, kind: "mention" })

    expect(promise).toMatchObject({ created: true, task: { kind: "promise", state: "open" } })
    expect(again).toEqual({ task: promise.task, created: false })
    expect(fromRule).toMatchObject({ created: false, task: { kind: "question", state: "dismissed" } })
  })

  it("keeps two accounts apart for the same locator", async () => {
    const { service } = setup()
    await service.add(question)
    const other = await service.add({ ...question, account: "max:owner" })

    expect(other.created).toBe(true)
    expect(await service.list({ account: "tg:owner" })).toHaveLength(1)
  })
})

describe("closing", () => {
  it("records who closed a task and when", async () => {
    const { service, advance } = setup()
    const { task } = await service.add(question)
    advance(60_000)

    const done = await service.close(task.id, { as: "done", by: "agent" })

    expect(done).toMatchObject({ state: "done", closedBy: "agent", closedAt: new Date("2026-10-04T10:01:00Z") })
    expect(done.reason).toBeUndefined()
  })

  it("refuses to close a closed task again", async () => {
    const { service } = setup()
    const { task } = await service.add(question)
    await service.close(task.id, { as: "done", by: "owner" })

    await expect(
      service.close(task.id, { as: "dismissed", by: "owner", reason: "no-reply-needed" }),
    ).rejects.toMatchObject({ code: "closed" })
  })

  it("names a task that does not exist", async () => {
    const { service } = setup()

    const error = await service.close("missing", { as: "done", by: "owner" }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TaskError)
    expect(error).toMatchObject({ code: "not_found", message: "no task missing" })
  })
})

describe("listing", () => {
  it("filters by state, group, kind and age", async () => {
    const { service, advance } = setup()
    const old = await service.add(question)
    advance(3_600_000)
    await service.add({ ...question, source: "msg:tg:chat-2:5", group: "chat-2", kind: "mention" })
    await service.close(old.task.id, { as: "done", by: "owner" })

    const ids = async (filter: Parameters<typeof service.list>[0]) =>
      (await service.list(filter)).map((task: Task) => task.source)

    expect(await ids({ state: "open" })).toEqual(["msg:tg:chat-2:5"])
    expect(await ids({ group: "chat-1" })).toEqual(["msg:tg:chat-1:100"])
    expect(await ids({ kind: "mention" })).toEqual(["msg:tg:chat-2:5"])
    expect(await ids({ createdBefore: new Date("2026-10-04T10:30:00Z") })).toEqual(["msg:tg:chat-1:100"])
  })
})

describe("stats", () => {
  it("counts open tasks per group, the oldest open one and the median time to close", async () => {
    const { service, advance } = setup()
    const a = await service.add({ ...question, source: "msg:1" })
    const b = await service.add({ ...question, source: "msg:2" })
    const c = await service.add({ ...question, source: "msg:3" })
    advance(1_000)
    await service.close(a.task.id, { as: "done", by: "owner" })
    advance(2_000)
    await service.close(b.task.id, { as: "done", by: "owner" })
    advance(5_000)
    await service.close(c.task.id, { as: "dismissed", by: "owner", reason: "no-reply-needed" })
    await service.add({ ...question, source: "msg:4" })
    await service.add({ ...question, source: "msg:5", group: "chat-2" })

    expect(await service.stats()).toEqual([
      { group: "chat-1", open: 1, oldestOpenAt: new Date("2026-10-04T10:00:08Z"), medianCloseMs: 3_000 },
      { group: "chat-2", open: 1, oldestOpenAt: new Date("2026-10-04T10:00:08Z") },
    ])
  })

  it("takes the mean of the two middle times when the count is even", async () => {
    const { service, advance } = setup()
    const a = await service.add({ ...question, source: "msg:1" })
    const b = await service.add({ ...question, source: "msg:2" })
    advance(1_000)
    await service.close(a.task.id, { as: "done", by: "owner" })
    advance(2_000)
    await service.close(b.task.id, { as: "done", by: "owner" })

    expect(await service.stats()).toEqual([{ group: "chat-1", open: 0, medianCloseMs: 2_000 }])
  })
})
