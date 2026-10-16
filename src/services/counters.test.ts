import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { CounterObservations } from "../domain/counters.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import { type MessageStore, openStore } from "../store/store.js"
import { countersService } from "./counters.js"
import { type ServiceDeps, storedDeps } from "./deps.js"

const account = { provider: "fixture", account: "owner" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
  vi.useRealTimers()
})
const setup = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "counter-service-")), "store.db") })
  opened.push(store)
  await store.chats.saveChats(account, [
    { id: "7", title: "Synthetic", kind: "group", unreadCount: null, lastMessageAt: null, participantsCount: null },
  ])
  await store.messages.saveMessages(
    account,
    "7",
    [1, 2, 3].map((id) => ({
      id: String(id),
      chatId: "7",
      senderId: "2",
      senderName: "Synthetic",
      text: "Synthetic",
      timestamp: `2026-10-01T12:00:0${id}Z`,
      editedAt: null,
      replyTo: null,
      forwardedFrom: null,
      attachments: [],
      outgoing: false,
      reactions: null,
      providerMetadata: { views: id },
    })),
    { via: "history" },
  )
  const fetchCounters = vi.fn(
    async (): Promise<CounterObservations> => ({
      views: { value: 20, observedAt: new Date().toISOString(), source: "remote_fetch" },
    }),
  )
  const close = vi.fn(async () => {})
  const adapter = { fetchCounters, close } as unknown as MessengerAdapter
  const messenger = {
    provider: "fixture",
    app: { command: "fixture" },
    counterFields: ["views"],
  } as unknown as Messenger
  const check = vi.fn(),
    ask = vi.fn(async () => {}),
    connection = vi.fn(async () => adapter)
  const deps: ServiceDeps = {
    ...storedDeps(messenger, store, account, { check, ask, record() {} }),
    offline: false,
    connection,
  }
  return { service: countersService(deps), store, deps, fetchCounters, close, check, ask, connection }
}
describe("counter services", () => {
  it("shows bounded per-field states and pins exact targets without connecting", async () => {
    const f = await setup()
    const found = await f.service.show({ chat: "7", counters: "views", limit: 2 })
    expect(found).toMatchObject({
      included: 2,
      hasMore: true,
      items: [{ messageId: "3", counters: [{ value: 3, freshness: "unknown" }] }, { messageId: "2" }],
    })
    expect(f.connection).not.toHaveBeenCalled()
    const replay = await f.service.show({ selection: found.selection, counters: "views", limit: 1 })
    expect(replay.items[0]?.locator).toBe(found.items[0]?.locator)
    expect(replay.hasMore).toBe(true)
  })
  it("previews scope and capabilities without a connection or write permission", async () => {
    const f = await setup()
    const before = await f.service.show({ chat: "7", limit: 1 })
    expect(await f.service.refresh({ chat: "7", limit: 1, dryRun: true })).toMatchObject({
      dryRun: true,
      targets: [before.items[0]?.locator],
      supported: ["views"],
      unsupported: ["reactions", "comments"],
    })
    expect(f.connection).not.toHaveBeenCalled()
    expect(f.check).not.toHaveBeenCalled()
    expect((await f.service.show({ chat: "7", limit: 1 })).items).toEqual(before.items)
  })
  it("refreshes exact counter fields and reports unsupported, missing and failed results", async () => {
    const f = await setup()
    const result = await f.service.refresh({ chat: "7", limit: 1 })
    expect(result).toMatchObject({
      dryRun: false,
      complete: false,
      items: [{ updated: ["views"], status: "updated" }],
      unsupported: ["reactions", "comments"],
    })
    expect(f.fetchCounters).toHaveBeenCalledWith("7", "3", ["views"], expect.any(AbortSignal))
    expect(f.check).toHaveBeenCalledWith({ chatId: null, key: "stats.messages.counters.refresh" }, { reserve: false })
    expect((await f.service.show({ chat: "7", limit: 1, counters: "views" })).items[0]?.counters[0]).toMatchObject({
      value: 20,
      freshness: "fresh",
    })
    f.fetchCounters.mockResolvedValueOnce({})
    expect(await f.service.refresh({ chat: "7", counters: "views", limit: 1 })).toMatchObject({
      complete: false,
      items: [{ status: "missing", missing: ["views"] }],
    })
    f.fetchCounters.mockRejectedValueOnce(new Error("Synthetic failure"))
    expect(await f.service.refresh({ chat: "7", counters: "views", limit: 1 })).toMatchObject({
      complete: false,
      items: [{ status: "failed" }],
    })
  })
  it("reports a target deleted during its read as skipped instead of updated", async () => {
    const f = await setup()
    f.fetchCounters.mockImplementationOnce(async () => {
      await f.store.messages.markDeleted(account, ["3"], { chatId: "7" })
      return { views: { value: 20, observedAt: new Date().toISOString(), source: "remote_fetch" } }
    })
    expect(await f.service.refresh({ chat: "7", counters: "views", limit: 1 })).toMatchObject({
      complete: false,
      items: [{ status: "skipped", updated: [] }],
    })
  })

  it("refuses implicit, foreign, conflicting and unbounded refresh selections", async () => {
    const f = await setup()
    await expect(f.service.refresh({ limit: 1 })).rejects.toThrow("explicit")
    await expect(f.service.show({ limit: 101 })).rejects.toThrow("1–100")
    await expect(f.service.show({ counters: "views,views", limit: 1 })).rejects.toThrow("distinct")
    await expect(f.service.refresh({ chat: "7", syncTime: "6m", limit: 1 })).rejects.toThrow("5m")
    const selection = { kind: "counter-targets", version: 1, locators: ["msg:fixture/other/7/3"] }
    await expect(f.service.refresh({ selection, limit: 1 })).rejects.toThrow("outside")
    await expect(f.service.refresh({ selection, chat: "7", limit: 1 })).rejects.toThrow("combined")
    f.deps.offline = true
    await expect(f.service.refresh({ chat: "7", limit: 1 })).rejects.toThrow("online")
    expect(f.connection).not.toHaveBeenCalled()
  })
  it("closes a stalled adapter at the time budget and applies no late response", async () => {
    const f = await setup()
    vi.useFakeTimers()
    f.fetchCounters.mockImplementationOnce(() => new Promise(() => {}))
    const pending = f.service.refresh({ chat: "7", counters: "views", limit: 1, syncTime: "1s" })
    await vi.waitFor(() => expect(f.fetchCounters).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toMatchObject({ stopped: "time", complete: false, items: [] })
    expect(f.close).toHaveBeenCalledOnce()
  })
})
