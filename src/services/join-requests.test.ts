import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { GuardRequest, SendGuard } from "../sends/guard.js"
import type { SendEntry } from "../sends/journal.js"
import { adminService } from "./admin.js"
import { onlineDeps } from "./deps.js"

const chat = { id: "-1007", title: "synthetic group", kind: "group" as const }
const request = {
  person: { id: "42", name: "Synthetic Person", username: "synthetic_person" },
  requestedAt: "2026-10-07T18:00:00.000Z",
  about: "synthetic note",
}

const fixture = (capable = true) => {
  const records: Omit<SendEntry, "at" | "profile">[] = []
  const checked: GuardRequest[] = []
  const guard = {
    check: (attempt: GuardRequest) => checked.push(attempt),
    record: (entry) => records.push(entry),
  } as SendGuard
  const joinRequests = vi.fn(async () => ({ items: [request], hasMore: true }))
  const answerJoinRequest = vi.fn(async () => ({ already: false }))
  const adapter = {
    resolve: async () => chat,
    people: async (references: string[]) => references.map((one) => one.trim()),
    ...(capable ? { joinRequests, answerJoinRequest } : {}),
  } as unknown as MessengerAdapter
  const deps = onlineDeps({ provider: "test" } as Messenger, adapter, guard)
  return { service: adminService(deps), deps, joinRequests, answerJoinRequest, records, checked }
}

describe("join requests", () => {
  it("lists a page of them for the resolved chat, and writes nothing", async () => {
    const f = fixture()
    expect(await f.service.requests("synthetic group", { limit: 5 })).toEqual({
      chatId: "-1007",
      items: [request],
      hasMore: true,
    })
    expect(f.joinRequests).toHaveBeenCalledWith("-1007", { limit: 5 })
    expect(f.checked).toEqual([])
    expect(f.records).toEqual([])
  })

  it.each([
    [true, "requests.accept"],
    [false, "requests.decline"],
  ] as const)("answers one (accept %s) through the guard as %s, checking the group only", async (accept, action) => {
    const f = fixture()
    expect(await f.service.answerRequest("synthetic group", "42", accept)).toMatchObject({
      chatId: "-1007",
      personId: "42",
      accepted: accept,
      already: false,
    })
    expect(f.answerJoinRequest).toHaveBeenCalledWith("-1007", "42", accept)
    expect(f.checked).toEqual([expect.objectContaining({ chatId: "-1007", kind: "chat", action, people: 1 })])
    expect(f.checked[0]).not.toHaveProperty("personIds")
    expect(f.records).toMatchObject([{ action, outcome: "sent" }])
    expect(JSON.stringify(f.records)).not.toContain("synthetic note")
  })

  it("says when the person was already a member", async () => {
    const f = fixture()
    f.answerJoinRequest.mockResolvedValueOnce({ already: true })
    expect(await f.service.answerRequest("synthetic group", "42", true)).toMatchObject({ already: true })
  })

  it("refuses offline, before connecting", async () => {
    const f = fixture()
    const connection = vi.fn(f.deps.connection)
    const offline = adminService({ ...f.deps, offline: true, connection })
    await expect(offline.requests("synthetic group", { limit: 5 })).rejects.toThrow("not with --offline")
    await expect(offline.answerRequest("synthetic group", "42", true)).rejects.toThrow("not with --offline")
    expect(connection).not.toHaveBeenCalled()
  })

  it("refuses a messenger without join requests, recording nothing", async () => {
    const f = fixture(false)
    await expect(f.service.requests("synthetic group", { limit: 5 })).rejects.toThrow("cannot read join requests")
    await expect(f.service.answerRequest("synthetic group", "42", false)).rejects.toThrow("cannot answer join requests")
    expect(f.records).toEqual([])
  })
})

describe("answering every join request", () => {
  const many = (total: number | undefined, items = 2) => {
    const f = fixture()
    const answerAllJoinRequests = vi.fn(async () => {})
    const adapter = {
      resolve: async () => chat,
      joinRequests: vi.fn(async () => ({ items: Array(items).fill(request), hasMore: false, total })),
      answerAllJoinRequests,
    } as unknown as MessengerAdapter
    return {
      ...f,
      service: adminService(onlineDeps({ provider: "test" } as Messenger, adapter, f.deps.guard)),
      adapter,
      answerAllJoinRequests,
    }
  }

  it("counts them first, then answers all in one guarded write weighted by that count", async () => {
    const f = many(3)
    expect(await f.service.answerAllRequests("synthetic group", true, { link: "https://t.me/+one" })).toMatchObject({
      chatId: "-1007",
      accepted: true,
      counted: 3,
    })
    expect(f.adapter.joinRequests).toHaveBeenCalledWith("-1007", { limit: 100, link: "https://t.me/+one" })
    expect(f.answerAllJoinRequests).toHaveBeenCalledWith("-1007", true, "https://t.me/+one")
    expect(f.checked).toEqual([expect.objectContaining({ action: "requests.accept", count: 3 })])
  })

  it("writes nothing when none are pending", async () => {
    const f = many(0, 0)
    expect(await f.service.answerAllRequests("synthetic group", false, {})).toEqual({
      chatId: "-1007",
      accepted: false,
      counted: 0,
    })
    expect(f.answerAllJoinRequests).not.toHaveBeenCalled()
    expect(f.checked).toEqual([])
  })
})
