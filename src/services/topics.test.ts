import { CliError } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import { withDeadline } from "../cli/deadline.js"
import type { Messenger } from "../cli/messenger/context.js"
import type { ForumState, MessengerAdapter } from "../cli/messenger/port.js"
import type { SendGuard } from "../sends/guard.js"
import type { SendEntry } from "../sends/journal.js"
import { onlineDeps } from "./deps.js"
import { topicsService } from "./topics.js"

const state = (id = "7", extra: Partial<ForumState> = {}): ForumState => ({
  chat: { id, title: "synthetic group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 3 },
  forum: false,
  needsUpgrade: true,
  owner: true,
  canCreate: true,
  linkedDiscussion: false,
  ...extra,
})
const topic = {
  id: "12",
  title: "synthetic topic",
  closed: false,
  pinned: false,
  unreadCount: 0,
  lastMessageAt: null,
  createdAt: "2026-10-03T00:00:00Z",
}
const fixture = (original = state()) => {
  const records: Omit<SendEntry, "at" | "profile">[] = []
  const guard: SendGuard = { check: vi.fn(), record: (entry) => records.push(entry) }
  const adapter = {
    resolve: async () => original.chat,
    forumState: vi.fn(async (id: string) => (id === "7" ? original : state("8", { needsUpgrade: false }))),
    upgradeForum: vi.fn(async () => state("8", { needsUpgrade: false })),
    enableForum: vi.fn(async (id: string) => state(id, { needsUpgrade: false, forum: true })),
    createTopic: vi.fn(async () => topic),
    newSendId: () => "42",
  } as unknown as MessengerAdapter
  const deps = onlineDeps({ provider: "test" } as Messenger, adapter, guard)
  return { adapter, guard, records, deps, service: topicsService(deps) }
}

describe("forum control through the shared service", () => {
  it("upgrades explicitly, enables on the new peer and journals both stages without titles", async () => {
    const f = fixture()
    const result = await f.service.enable("synthetic", { upgrade: true })
    expect(result).toMatchObject({ previousChatId: "7", chat: { id: "8" }, upgraded: true, forum: true })
    expect(f.adapter.upgradeForum).toHaveBeenCalledWith("7")
    expect(f.adapter.enableForum).toHaveBeenCalledWith("8")
    expect(f.records).toMatchObject([
      { chatId: "7", action: "forum-upgrade", resultChatId: "8", outcome: "sent" },
      { chatId: "8", action: "forum-enable", outcome: "sent" },
    ])
    expect(JSON.stringify(f.records)).not.toContain("synthetic")
  })
  it.each([{ owner: false }, { linkedDiscussion: true }, {}])(
    "refuses invalid upgrade preconditions %j",
    async (extra) => {
      const f = fixture(state("7", extra))
      await expect(f.service.enable("synthetic", { upgrade: false })).rejects.toThrow()
      expect(f.adapter.upgradeForum).not.toHaveBeenCalled()
      expect(f.adapter.enableForum).not.toHaveBeenCalled()
    },
  )
  it("refuses readonly before the forum preflight", async () => {
    const f = fixture()
    f.guard.check = () => {
      throw new CliError("permission_error", "readonly")
    }
    await expect(f.service.enable("synthetic", { upgrade: true })).rejects.toThrow("readonly")
    expect(f.adapter.forumState).not.toHaveBeenCalled()
    expect(f.records[0]?.outcome).toBe("refused")
  })
  it("enables a supergroup directly and leaves an existing forum unchanged", async () => {
    const f = fixture(state("7", { needsUpgrade: false }))
    expect((await f.service.enable("synthetic", { upgrade: false })).upgraded).toBe(false)
    expect(f.adapter.enableForum).toHaveBeenCalledTimes(1)
    const ready = fixture(state("7", { needsUpgrade: false, forum: true }))
    await ready.service.enable("synthetic", { upgrade: false })
    expect(ready.adapter.upgradeForum).not.toHaveBeenCalled()
    expect(ready.adapter.enableForum).not.toHaveBeenCalled()
  })
  it("rechecks a redirected peer and returns partial state if the new recipient is denied", async () => {
    const f = fixture()
    f.guard.check = ({ chatId }) => {
      if (chatId === "8") throw new CliError("permission_error", "recipient denied")
    }
    await expect(f.service.enable("synthetic", { upgrade: true })).rejects.toMatchObject({
      code: "permission_error",
      details: { previous_chat_id: "7", chat_id: "8", upgraded: true, stage: "enable", forum: null },
    })
    expect(f.adapter.enableForum).not.toHaveBeenCalled()
    expect(f.records).toMatchObject([{ outcome: "sent" }, { outcome: "refused" }])
    const redirected = fixture(state("8", { needsUpgrade: false }))
    await redirected.service.enable("synthetic", { upgrade: false })
    expect(redirected.adapter.enableForum).toHaveBeenCalledWith("8")
  })
  it("never enables after a late migration answer following a command deadline", async () => {
    const f = fixture()
    let release = () => {}
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    f.adapter.upgradeForum = vi.fn(async () => {
      await wait
      return state("8", { needsUpgrade: false })
    })
    let body: Promise<unknown> | undefined
    await expect(
      withDeadline(1, [], () => {
        body = f.service.enable("synthetic", { upgrade: true })
        return body
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown" })
    release()
    await expect(body).rejects.toMatchObject({ code: "outcome_unknown" })
    expect(f.adapter.enableForum).not.toHaveBeenCalled()
    expect(f.records).toHaveLength(1)
  })
  it("preserves create identity and refuses missing forum, rights and invalid UTF-8 titles", async () => {
    const f = fixture(state("7", { forum: true, needsUpgrade: false }))
    await f.service.create("synthetic", "new topic", { sendId: "99" })
    await f.service.create("synthetic", "new topic", {})
    expect(f.adapter.createTopic).toHaveBeenCalledWith("7", "new topic", { sendId: "99" })
    expect(f.adapter.createTopic).toHaveBeenCalledWith("7", "new topic", { sendId: "42" })
    expect(f.records[0]).toMatchObject({ threadId: "12", sendId: "99", length: 9 })
    expect(JSON.stringify(f.records)).not.toContain("new topic")
    await expect(f.service.create("synthetic", "🧪".repeat(33), {})).rejects.toThrow("UTF-8")
    await expect(f.service.create("synthetic", " ", {})).rejects.toThrow("UTF-8")
    await expect(fixture().service.create("synthetic", "new", {})).rejects.toThrow("enable topics first")
    await expect(
      fixture(state("7", { forum: true, canCreate: false })).service.create("synthetic", "new", {}),
    ).rejects.toThrow("manage-topics")
  })
  it("refuses offline and unsupported providers", async () => {
    const f = fixture()
    await expect(topicsService({ ...f.deps, offline: true }).enable("synthetic", { upgrade: true })).rejects.toThrow(
      "--offline",
    )
    await expect(
      topicsService(onlineDeps({} as Messenger, { resolve: f.adapter.resolve } as MessengerAdapter, f.guard)).enable(
        "synthetic",
        { upgrade: true },
      ),
    ).rejects.toThrow("cannot configure")
  })
})
