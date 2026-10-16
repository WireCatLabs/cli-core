import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CounterObservations } from "../domain/counters.js"
import type { Message } from "../domain/models.js"
import { type AccountKey, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "max", account: "1" }
const NOW = Date.parse("2026-10-08T12:00:00Z")
const ISO = new Date(NOW).toISOString()
const message = (extra: Partial<Message> = {}): Message => ({
  id: "1",
  chatId: "7",
  senderId: "2",
  senderName: "Member",
  timestamp: "2026-09-01T12:00:00Z",
  editedAt: null,
  text: "Synthetic body",
  outgoing: false,
  attachments: [],
  replyTo: null,
  replyToId: "9",
  forwardedFrom: null,
  reactions: { total: 2, mine: null, counts: [{ reaction: "👍", count: 2 }] },
  providerMetadata: { views: 10, unrelated: "preserve" },
  ...extra,
})
const setup = async () => {
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "counter-observations-")), "store.db"),
    now: () => NOW,
  })
  await store.messages.saveMessages(OWNER, "7", [message()], { via: "history" })
  return store
}
const observations = (value: number, observedAt = ISO): CounterObservations => ({
  views: { value, observedAt, source: "remote_fetch" },
})

describe("authoritative counter observations", () => {
  it("leaves legacy values unknown and preserves missing fields", async () => {
    const store = await setup()
    try {
      expect(await store.counters.counterStates?.(OWNER, "7", "1", { now: NOW, maxAge: 1000 })).toMatchObject([
        { counter: "views", value: 10, observedAt: null, freshness: "unknown" },
        { counter: "reactions", value: 2, observedAt: null, freshness: "unknown" },
        { counter: "comments", value: null, observedAt: null, freshness: "unknown" },
      ])
      await store.messages.saveMessages(OWNER, "7", [message({ providerMetadata: { unrelated: "new" } })], {
        via: "context",
      })
      expect((await store.messages.messages(OWNER, "7", { limit: 1 })).items[0]?.providerMetadata).toEqual({
        views: 10,
        unrelated: "new",
      })
    } finally {
      await store.close()
    }
  })
  it("ties freshness to each value and survives an older writer changing it", async () => {
    const store = await setup()
    try {
      await store.counters.updateCounterObservations?.(OWNER, "7", "1", observations(20))
      expect(await store.counters.counterStates?.(OWNER, "7", "1", { now: NOW + 1001, maxAge: 1000 })).toMatchObject([
        { counter: "views", value: 20, observedAt: ISO, freshness: "stale" },
        { counter: "reactions", freshness: "unknown" },
        { counter: "comments", freshness: "unknown" },
      ])
      const saved = (await store.messages.messages(OWNER, "7", { limit: 1 })).items[0]
      expect(saved).toMatchObject({
        text: "Synthetic body",
        replyToId: "9",
        providerMetadata: { views: 20, unrelated: "preserve" },
      })
      await store.messages.saveMessages(OWNER, "7", [message({ providerMetadata: { views: 30 } })], { via: "update" })
      expect((await store.counters.counterStates?.(OWNER, "7", "1", { now: NOW, maxAge: 1000 }))?.[0]).toMatchObject({
        value: 30,
        observedAt: null,
        freshness: "unknown",
      })
    } finally {
      await store.close()
    }
  })
  it("accepts explicit remote markers but does not replace newer observations with older ones", async () => {
    const store = await setup()
    try {
      await store.messages.saveMessages(OWNER, "7", [message({ counterObservations: observations(20) })], {
        via: "history",
      })
      expect(
        await store.counters.updateCounterObservations?.(
          OWNER,
          "7",
          "1",
          observations(15, new Date(NOW - 1000).toISOString()),
        ),
      ).toBe(0)
      expect((await store.counters.counterStates?.(OWNER, "7", "1", { now: NOW, maxAge: 1000 }))?.[0]).toMatchObject({
        value: 20,
        observedAt: ISO,
        freshness: "fresh",
      })
      await expect(
        store.counters.updateCounterObservations?.(OWNER, "7", "1", observations(25, new Date(NOW + 1).toISOString())),
      ).rejects.toThrow("nonfuture")
      expect((await store.counters.counterStates?.(OWNER, "7", "1", { now: NOW, maxAge: 1000 }))?.[0]?.value).toBe(20)
    } finally {
      await store.close()
    }
  })
  it("does not revive tombstones and isolates accounts", async () => {
    const store = await setup()
    try {
      expect(
        await store.counters.updateCounterObservations?.(
          { provider: "max", account: "other" },
          "7",
          "1",
          observations(20),
        ),
      ).toBe(0)
      await store.messages.markDeleted(OWNER, ["1"], { chatId: "7" })
      expect(await store.counters.updateCounterObservations?.(OWNER, "7", "1", observations(20))).toBe(0)
      expect(await store.counters.counterStates?.(OWNER, "7", "1", { now: NOW, maxAge: 1000 })).toEqual([])
      expect((await store.messages.messages(OWNER, "7", { limit: 1 })).items).toEqual([])
    } finally {
      await store.close()
    }
  })
})
