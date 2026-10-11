import { describe, expect, it } from "vitest"
import type { Task } from "../model.js"
import { memoryTaskStore } from "./memory-store.js"

const task: Task = {
  id: "t1",
  source: "msg:1",
  sourceKind: "message",
  account: "tg:owner",
  group: "chat-1",
  kind: "question",
  state: "open",
  origin: "rule",
  createdAt: new Date("2026-10-04T10:00:00Z"),
}

describe("memoryTaskStore", () => {
  it("hands out copies, so a caller's change does not reach the store", async () => {
    const store = memoryTaskStore([task])
    const held = await store.get("t1")
    if (held) held.state = "done"

    expect((await store.get("t1"))?.state).toBe("open")
  })

  it("refuses a second insert of one id and an update of a missing one", async () => {
    const store = memoryTaskStore([task])

    await expect(store.insert(task)).rejects.toThrow("task t1 already exists")
    await expect(store.update({ ...task, id: "t2" })).rejects.toThrow("no task t2")
  })

  it("answers and judges a task it holds, and refuses a missing task or an unknown verdict", async () => {
    const store = memoryTaskStore([task])

    await expect(store.answer("t1", { resolution: "Friday works", by: "msg:2" })).resolves.toBeUndefined()
    await expect(store.judge("t1", "useful")).resolves.toBeUndefined()
    await expect(store.judge("t1", null)).resolves.toBeUndefined()
    await expect(store.answer("t2", { resolution: "Friday works" })).rejects.toThrow("no task t2")
    await expect(store.judge("t2", "useful")).rejects.toThrow("no task t2")
    await expect(store.judge("t1", "great" as "useful")).rejects.toThrow("no verdict great")
  })
})
