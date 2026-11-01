import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { GuardRequest, SendGuard } from "../sends/guard.js"
import type { SendEntry } from "../sends/journal.js"
import { onlineDeps } from "./deps.js"
import { topicsService } from "./topics.js"

const chat = { id: "7", title: "synthetic group", kind: "group" as const }
const topic = {
  id: "12",
  title: "renamed synthetic topic",
  closed: true,
  pinned: false,
  unreadCount: 0,
  lastMessageAt: null,
  createdAt: null,
}

const fixture = (capable = true) => {
  const records: Omit<SendEntry, "at" | "profile">[] = []
  const checked: GuardRequest[] = []
  const guard = {
    check: (request: GuardRequest) => checked.push(request),
    record: (entry) => records.push(entry),
  } as SendGuard
  const editTopic = vi.fn(async () => topic)
  const orderPinnedTopics = vi.fn(async () => {})
  const adapter = {
    resolve: async () => chat,
    ...(capable ? { editTopic, orderPinnedTopics } : {}),
  } as unknown as MessengerAdapter
  const deps = onlineDeps({ provider: "test" } as Messenger, adapter, guard)
  return { service: topicsService(deps), deps, editTopic, orderPinnedTopics, records, checked }
}

describe("editing a forum topic", () => {
  it.each([
    [{ title: "renamed synthetic topic" }, "topic-edit"],
    [{ closed: true }, "topic-close"],
    [{ closed: false }, "topic-reopen"],
    [{ title: "renamed synthetic topic", closed: true }, "topic-edit"],
    [{ pinned: true }, "topic-pin"],
    [{ pinned: false }, "topic-unpin"],
    [{ closed: true, pinned: true }, "topic-edit"],
    [{ hidden: true }, "topic-hide"],
    [{ hidden: false }, "topic-unhide"],
    [{ icon: "🤖" }, "topic-edit"],
    [{ icon: null }, "topic-edit"],
  ] as const)("passes %j and journals %s with the topic id, never the title", async (change, action) => {
    const f = fixture()
    expect(await f.service.edit("synthetic group", " 12 ", change)).toMatchObject({ chatId: "7", topic })
    expect(f.editTopic).toHaveBeenCalledWith("7", "12", change)
    expect(f.checked[0]).toMatchObject({ kind: "chat", action, key: "topics.edit", threadId: "12" })
    expect(f.records).toMatchObject([{ action, threadId: "12", outcome: "sent" }])
    expect(JSON.stringify(f.records)).not.toContain("renamed")
  })

  it.each([
    [{}, "nothing to change"],
    [{ title: " " }, "1–128 UTF-8 bytes"],
    [{ title: "x".repeat(129) }, "1–128 UTF-8 bytes"],
    [{ icon: " " }, "which icon"],
  ])("refuses %j before connecting", async (change, message) => {
    const f = fixture()
    const connection = vi.fn(f.deps.connection)
    await expect(topicsService({ ...f.deps, connection }).edit("7", "12", change)).rejects.toThrow(message)
    expect(connection).not.toHaveBeenCalled()
  })

  it("refuses a blank topic, offline, and a messenger without topics", async () => {
    await expect(fixture().service.edit("7", " ", { closed: true })).rejects.toThrow("which topic")
    const offline = fixture()
    await expect(topicsService({ ...offline.deps, offline: true }).edit("7", "12", { closed: true })).rejects.toThrow(
      "not with --offline",
    )
    await expect(fixture(false).service.edit("7", "12", { closed: true })).rejects.toThrow("cannot edit forum topics")
  })
})

describe("topic icons", () => {
  it("lists the messenger's icon set, and refuses offline and a messenger without one", async () => {
    const topicIcons = vi.fn(async () => ["🤖", "📰"])
    const deps = (capable: boolean) =>
      onlineDeps(
        { provider: "test" } as Messenger,
        (capable ? { topicIcons } : {}) as unknown as MessengerAdapter,
        {} as SendGuard,
      )
    expect(await topicsService(deps(true)).icons()).toEqual(["🤖", "📰"])
    await expect(topicsService({ ...deps(true), offline: true }).icons()).rejects.toThrow("not with --offline")
    await expect(topicsService(deps(false)).icons()).rejects.toThrow("cannot list topic icons")
  })

  it("passes a trimmed icon to a new topic", async () => {
    const createTopic = vi.fn(async () => topic)
    const guard = { check: () => {}, record: () => {} } as unknown as SendGuard
    const adapter = {
      resolve: async () => chat,
      createTopic,
      forumState: async () => ({ chat, forum: true, canCreate: true }),
    } as unknown as MessengerAdapter
    const service = topicsService(onlineDeps({ provider: "test" } as Messenger, adapter, guard))
    await service.create("7", "synthetic", { sendId: "42", icon: " 🤖 " })
    expect(createTopic).toHaveBeenCalledWith("7", "synthetic", { sendId: "42", icon: "🤖" })
    await expect(service.create("7", "synthetic", { sendId: "43", icon: "" })).rejects.toThrow("which icon")
  })
})

describe("ordering pinned topics", () => {
  it("passes the ids in order and journals topic-order", async () => {
    const f = fixture()
    expect(await f.service.order("synthetic group", [" 12", "3 "])).toMatchObject({ chatId: "7", order: ["12", "3"] })
    expect(f.orderPinnedTopics).toHaveBeenCalledWith("7", ["12", "3"])
    expect(f.records).toMatchObject([{ action: "topic-order", outcome: "sent" }])
  })

  it.each([[[]], [["12", " "]], [["12", "12"]]])("refuses %j before connecting", async (order) => {
    const f = fixture()
    const connection = vi.fn(f.deps.connection)
    await expect(topicsService({ ...f.deps, connection }).order("7", order)).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(connection).not.toHaveBeenCalled()
  })

  it("refuses a messenger without the capability", async () => {
    await expect(fixture(false).service.order("7", ["12"])).rejects.toThrow("cannot order pinned forum topics")
  })
})

describe("deleting a forum topic", () => {
  it("deletes through the guard by topic id, and refuses General, a blank id and a messenger without it", async () => {
    const records: Omit<SendEntry, "at" | "profile">[] = []
    const checked: GuardRequest[] = []
    const guard = {
      check: (request: GuardRequest) => checked.push(request),
      record: (entry) => records.push(entry),
    } as SendGuard
    const deleteTopic = vi.fn(async () => {})
    const service = (capable: boolean) =>
      topicsService(
        onlineDeps(
          { provider: "test" } as Messenger,
          { resolve: async () => chat, ...(capable ? { deleteTopic } : {}) } as unknown as MessengerAdapter,
          guard,
        ),
      )

    expect(await service(true).delete("synthetic group", " 12 ")).toMatchObject({ chatId: "7", topicId: "12" })
    expect(deleteTopic).toHaveBeenCalledWith("7", "12")
    expect(checked[0]).toMatchObject({ action: "topic-delete", key: "topics.delete", threadId: "12" })
    await expect(service(true).delete("7", "1")).rejects.toThrow("General topic cannot be deleted")
    await expect(service(true).delete("7", " ")).rejects.toThrow("which topic")
    await expect(service(false).delete("7", "12")).rejects.toThrow("cannot delete forum topics")
    expect(deleteTopic).toHaveBeenCalledOnce()
  })
})
