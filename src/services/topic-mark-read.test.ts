import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { SendGuard } from "../sends/guard.js"
import type { SendEntry } from "../sends/journal.js"
import { chatsService } from "./chats.js"
import { onlineDeps } from "./deps.js"

const fixture = (capable = true) => {
  const records: Omit<SendEntry, "at" | "profile">[] = []
  const guard = { check: () => {}, record: (entry) => records.push(entry) } as SendGuard
  const markRead = vi.fn(async () => {})
  const markTopicRead = vi.fn(async () => {})
  const adapter = {
    resolve: async () => ({ id: "7", title: "synthetic", kind: "group" }),
    markRead,
    ...(capable ? { markTopicRead } : {}),
  } as unknown as MessengerAdapter
  const service = chatsService(onlineDeps({ provider: "test" } as Messenger, adapter, guard))
  return { service, markRead, markTopicRead, records }
}

describe("marking one forum topic read", () => {
  it("marks only the topic, up to a message, and journals the topic id", async () => {
    const f = fixture()
    expect(await f.service.markRead({ chat: "synthetic", threadId: " 12 ", until: "40" })).toMatchObject({
      chatId: "7",
      until: "40",
      threadId: "12",
    })
    expect(f.markTopicRead).toHaveBeenCalledWith("7", "12", "40")
    expect(f.markRead).not.toHaveBeenCalled()
    expect(f.records).toMatchObject([{ kind: "read", threadId: "12", messageId: "40", outcome: "sent" }])
  })

  it("refuses rather than mark the whole chat read where the messenger has no topics", async () => {
    const f = fixture(false)
    await expect(f.service.markRead({ chat: "synthetic", threadId: "12" })).rejects.toThrow(
      "cannot mark a forum topic read",
    )
    expect(f.markRead).not.toHaveBeenCalled()
  })

  it("leaves a whole-chat mark without a topic", async () => {
    const f = fixture()
    expect(await f.service.markRead({ chat: "synthetic" })).not.toHaveProperty("threadId")
    expect(f.markRead).toHaveBeenCalledWith("7", undefined)
  })
})

describe("chats mark-read on a plain adapter (BUG-275)", () => {
  const messenger = (topics?: false) =>
    ({ provider: "test", chatArgument: "a chat", ...(topics === false ? { topics } : {}) }) as Messenger

  it("marks a chat read on an adapter that has markRead alone", async () => {
    const markRead = vi.fn(async () => {})
    const adapter = {
      resolve: async () => ({ id: "7", title: "synthetic", kind: "dialog" }),
      markRead,
    } as unknown as MessengerAdapter
    const guard = { check: () => {}, record: () => {} } as unknown as SendGuard
    await chatsService(onlineDeps(messenger(false), adapter, guard)).markRead({ chat: "synthetic" })
    expect(markRead).toHaveBeenCalledWith("7", undefined)
  })
})
