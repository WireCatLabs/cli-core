import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import { openStore } from "../store/store.js"
import { gapsService } from "./archive-gaps.js"
import { storedDeps } from "./deps.js"

const account = { provider: "test", account: "500" }
const message = (id: number): Message => ({
  id: String(id),
  chatId: "7",
  senderId: "test",
  senderName: null,
  timestamp: new Date(1000 + id * 1000).toISOString(),
  editedAt: null,
  text: `synthetic ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const fixture = async (byTime = false, ties = false) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "gap-repair-")), "fixture.db") })
  const key = (id: number) => (byTime ? Date.parse(message(id).timestamp) : id)
  await store.saveMessages(account, "7", [message(1), message(3), message(7), message(9)], { via: "history" })
  await store.markRange(account, "7", key(1), key(3))
  await store.markRange(account, "7", key(7), key(9))
  const messenger = {
    provider: "test",
    app: { command: "chat" },
    chatArgument: "a chat",
    fetching: {
      page: 3,
      maxPageSize: 3,
      maxPages: 10,
      pause: "1ms",
      orderBy: byTime ? "time" : "id",
      beforeInclusive: byTime,
    },
  } as Messenger
  const connect = vi.fn(
    async () =>
      ({
        self: () => "500",
        history: async (_chat: string, { before, limit }: { before?: string; limit: number }) => {
          const bound = before === undefined ? Infinity : byTime ? Date.parse(before) : Number(before)
          const all = Array.from({ length: 9 }, (_, index) => message(index + 1)).map((one) =>
            ties ? { ...one, timestamp: message(5).timestamp } : one,
          )
          const older = all.filter((one) => (byTime ? Date.parse(one.timestamp) <= bound : Number(one.id) < bound))
          const items = older.slice(-limit)
          await store.saveMessages(account, "7", items, { via: "history" })
          return { items, hasMore: older.length > items.length }
        },
      }) as unknown as MessengerAdapter,
  )
  const deps = {
    ...storedDeps(messenger, store, account, { check: () => {}, record: () => {} }),
    offline: false,
    connection: connect,
  }
  return { store, deps, connect, key }
}

describe("coverage gap repair", () => {
  it("plans from recorded coverage instead of inferring gaps from absent message ids", async () => {
    const { store, deps, connect } = await fixture()
    try {
      const planned = await gapsService(deps).plan("7")
      expect(planned.gaps).toEqual([{ from: 4, to: 6 }])
      expect(planned.unknown).toEqual({ older: true, newer: true })
      expect(planned).toHaveProperty("fingerprint", expect.any(String))
      expect(connect).not.toHaveBeenCalled()
      await store.markRange(account, "7", 1, 9)
      expect((await gapsService(deps).plan("7")).gaps).toEqual([])
      expect(await store.countMessages(account, "7")).toBe(4)
    } finally {
      await store.close()
    }
  })

  it("fetches and verifies the interior id window, with no history deletion", async () => {
    const { store, deps } = await fixture()
    try {
      const answer = await gapsService(deps).repair("7", { pauseMs: 0 })
      expect(answer).toMatchObject({
        complete: true,
        repaired: [{ from: 4, to: 6 }],
        fetched: 3,
        requests: 1,
        after: { gaps: [], unknown: { older: true, newer: true } },
      })
      expect(await store.countMessages(account, "7")).toBe(7)
    } finally {
      await store.close()
    }
  })

  it("keeps bounded or inaccessible coverage pending and rejects a stale fingerprint before connecting", async () => {
    const { store, deps, connect } = await fixture()
    try {
      const before = await gapsService(deps).plan("7")
      const bounded = await gapsService(deps).repair("7", { limit: 1, pauseMs: 0 })
      expect(bounded).toMatchObject({ complete: false, fetched: 1, stopped: "bound" })
      const count = connect.mock.calls.length
      await expect(gapsService(deps).repair("7", { fingerprint: before.fingerprint })).rejects.toMatchObject({
        code: "validation_error",
      })
      expect(connect).toHaveBeenCalledTimes(count)
      const inaccessible = {
        ...deps,
        connection: async () =>
          ({ self: () => "500", history: async () => ({ items: [], hasMore: false }) }) as unknown as MessengerAdapter,
      }
      expect(await gapsService(inaccessible).repair("7", { pauseMs: 0 })).toMatchObject({
        complete: false,
        stopped: "partial_or_inaccessible",
      })
      expect(await store.countMessages(account, "7")).toBe(5)
    } finally {
      await store.close()
    }
  })

  it("rechecks timestamp windows and refuses to certify a repeated timestamp burst", async () => {
    const normal = await fixture(true)
    try {
      const result = await gapsService(normal.deps).repair("7", { pauseMs: 0 })
      expect(result.complete).toBe(true)
      expect(result.after.gaps).toEqual([])
    } finally {
      await normal.store.close()
    }
    const repeated = await fixture(true, true)
    try {
      const result = await gapsService(repeated.deps).repair("7", { pauseMs: 0 })
      expect(result.complete).toBe(false)
      expect(result.stopped).toBe("partial_or_inaccessible")
      expect(result.requests).toBeLessThanOrEqual(3)
    } finally {
      await repeated.store.close()
    }
  })

  it("aborts an unanswered page, releases the lease and resumes from persisted coverage", async () => {
    const { store, deps } = await fixture()
    const controller = new AbortController()
    const pending = {
      ...deps,
      connection: async () =>
        ({
          self: () => "500",
          history: async () => {
            controller.abort()
            return new Promise<never>(() => {})
          },
        }) as unknown as MessengerAdapter,
    }
    try {
      const result = await gapsService(pending).repair("7", { signal: controller.signal, pauseMs: 0 })
      expect(result).toMatchObject({ complete: false, stopped: "bound", requests: 1 })
      expect((await gapsService(deps).repair("7", { pauseMs: 0 })).complete).toBe(true)
    } finally {
      await store.close()
    }
  })

  it("stops while a connection is pending and releases its repair lease", async () => {
    const { store, deps } = await fixture()
    const controller = new AbortController()
    try {
      const pending = {
        ...deps,
        connection: async () => {
          controller.abort()
          return new Promise<MessengerAdapter>(() => {})
        },
      }
      expect(await gapsService(pending).repair("7", { signal: controller.signal })).toMatchObject({
        complete: false,
        stopped: "bound",
        requests: 0,
      })
      expect((await gapsService(deps).repair("7", { pauseMs: 0 })).complete).toBe(true)
    } finally {
      await store.close()
    }
  })

  it("does not certify partial responses or another account's session", async () => {
    const { store, deps } = await fixture()
    try {
      const partial = {
        ...deps,
        connection: async () =>
          ({
            self: () => "500",
            history: async () => ({ items: [message(4)], hasMore: false, partial: true }),
          }) as unknown as MessengerAdapter,
      }
      expect(await gapsService(partial).repair("7", { pauseMs: 0 })).toMatchObject({ complete: false, repaired: [] })
      expect((await gapsService(deps).plan("7")).gaps).toEqual([{ from: 4, to: 6 }])
      const wrong = {
        ...deps,
        connection: async () =>
          ({ self: () => "501", history: async () => ({ items: [], hasMore: false }) }) as unknown as MessengerAdapter,
      }
      expect(await gapsService(wrong).repair("7", { pauseMs: 0 })).toMatchObject({
        complete: false,
        stopped: "fetch_failed",
        requests: 0,
      })
    } finally {
      await store.close()
    }
  })

  it("prepares only the repaired chat with explicit local bounds and keeps fetch completeness separate", async () => {
    const { store, deps } = await fixture()
    try {
      const result = await gapsService(deps).repair("7", {
        pauseMs: 0,
        catchUp: { maxMessages: 1, maxChunks: 1, timeMs: 1000 },
      })
      expect(result).toMatchObject({ complete: true, prepared: { complete: false, reason: "message_bound" } })
      expect(await store.countMessages(account, "7")).toBe(7)
      const checked = vi.fn(() => {
        throw new Error("preparation denied")
      })
      await expect(
        gapsService({ ...deps, guard: { check: checked, record: () => {} } }).repair("7", { catchUp: {} }),
      ).rejects.toThrow("preparation denied")
    } finally {
      await store.close()
    }
  })

  it("keeps account leases isolated and refuses invalid budgets", async () => {
    const { store, deps, connect } = await fixture()
    try {
      await store.claim(account, "7", "gaps", "other", 60_000)
      await expect(gapsService(deps).repair("7")).rejects.toThrow("another gap repair")
      await store.release(account, "7", "gaps", "other")
      await expect(gapsService(deps).repair("7", { maxGaps: 0 })).rejects.toMatchObject({ code: "validation_error" })
      expect(connect).not.toHaveBeenCalled()
    } finally {
      await store.close()
    }
  })
})
