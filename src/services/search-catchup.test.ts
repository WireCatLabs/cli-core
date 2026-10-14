import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import { openStore } from "../store/store.js"
import { archiveService } from "./archive.js"
import { conversationsService } from "./conversations.js"
import { storedDeps } from "./deps.js"
import { catchUpSearch, validateCatchUp } from "./search-catchup.js"

const account = { provider: "test", account: "synthetic" }
const messenger = { provider: "test", app: { command: "chat" }, chatArgument: "a chat" } as Messenger
const message = (id: string): Message => ({
  id,
  chatId: "7",
  senderId: "synthetic",
  senderName: null,
  timestamp: `2026-01-01T00:00:0${id}Z`,
  editedAt: null,
  text: `synthetic ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "catchup-"))
  const env = { ...process.env, WIRECAT_STATE_DIR: join(root, "empty-model-cache") }
  const store = await openStore({ path: join(root, "fixture.db") })
  const check = vi.fn()
  const guard = { check, record: () => {} }
  const connect = vi.fn(
    async () =>
      ({
        self: () => account.account,
        history: async (_chat: string, window: { before?: string }) => {
          const items = window.before ? [] : [message("1"), message("2")]
          await store.saveMessages(account, "7", items, { via: "history" })
          return { items, hasMore: false }
        },
      }) as unknown as MessengerAdapter,
  )
  const deps = { ...storedDeps(messenger, store, account, guard), env, offline: false, connection: connect }
  const options = {
    limit: 10,
    pageSize: 100,
    pauseMs: 0,
    note: () => {},
    stop: new AbortController().signal,
    onPage: () => {},
  }
  return { store, deps, options, connect, check }
}

describe("bounded local post-fetch preparation", () => {
  it("does nothing by default and builds only the fetched chat when explicitly enabled", async () => {
    const { store, deps, options } = await fixture()
    try {
      const normal = await archiveService(deps).fetch("7", options)
      expect(normal).not.toHaveProperty("prepared")
      expect(await store.conversationState(account, "7")).toBeUndefined()
      const done = await archiveService(deps).fetch("7", { ...options, catchUp: {} })
      expect(done.prepared).toMatchObject({
        complete: false,
        reason: "pending",
        prepared: { model: "e5-small", modelAvailable: false, built: [{ chat: "7" }], embedded: [] },
      })
      expect(await store.conversationState(account, "7")).toHaveProperty("builtAt")
    } finally {
      await store.close()
    }
  })

  it("accepts a profile opt-in and an explicit opt-out; message bounds retain fetched data", async () => {
    const { store, deps, options } = await fixture()
    try {
      const off = await archiveService({ ...deps, searchCatchUp: true }).fetch("7", { ...options, catchUp: false })
      expect(off).not.toHaveProperty("prepared")
      const capped = await archiveService(deps).fetch("7", { ...options, catchUp: { maxMessages: 1 } })
      expect(capped).toMatchObject({ fetched: 2, prepared: { complete: false, reason: "message_bound" } })
      expect(await store.countMessages(account, "7")).toBe(2)
      expect(await store.conversationState(account, "7")).toBeUndefined()
      expect(
        (await archiveService({ ...deps, searchCatchUp: true }).fetch("7", options)).prepared?.prepared?.built,
      ).toHaveLength(1)
    } finally {
      await store.close()
    }
  })

  it("refuses invalid bounds or permissions before a connection", async () => {
    const { store, deps, options, connect } = await fixture()
    try {
      await expect(archiveService(deps).fetch("7", { ...options, catchUp: { maxChunks: 0 } })).rejects.toMatchObject({
        code: "validation_error",
      })
      expect(connect).not.toHaveBeenCalled()
      const denied = {
        ...deps,
        guard: {
          check: () => {
            throw new Error("denied")
          },
          record: () => {},
        },
      }
      expect(() => validateCatchUp(denied, {})).toThrow("denied")
      expect(connect).not.toHaveBeenCalled()
    } finally {
      await store.close()
    }
  })

  it("reports time and cancellation with a synthetic clock, without publishing a partial graph", async () => {
    const { store, deps } = await fixture()
    try {
      await store.saveMessages(account, "7", [message("1"), message("2")], { via: "history" })
      let now = 0
      expect(await catchUpSearch(deps, "7", { timeMs: 1 }, new AbortController().signal, () => now++)).toMatchObject({
        complete: false,
        reason: "time_or_abort_bound",
      })
      const abort = new AbortController()
      abort.abort()
      expect(await catchUpSearch(deps, "7", {}, abort.signal)).toMatchObject({ reason: "time_or_abort_bound" })
      const service = conversationsService(deps)
      await service.build("7")
      const before = await store.conversationState(account, "7")
      let turns = 0
      await expect(
        service.build("7", {
          check: () => {
            if (++turns === 8) throw new Error("stop")
          },
        }),
      ).rejects.toThrow("stop")
      expect(await store.conversationState(account, "7")).toEqual(before)
    } finally {
      await store.close()
    }
  })
})
