import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { callbackDataOf, DECISION_TTL_MS, type DecisionAction, parseCallbackData } from "./decision-requests.js"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const keysOf = (store: MessageStore, input: Parameters<MessageStore["decisionRequests"]["create"]>[0]) =>
  Object.fromEntries(store.decisionRequests.create(input).map((m) => [m.action, m.token])) as Record<
    DecisionAction,
    string
  >

const MESSAGE = { channel: "telegram", botProfile: "review", chatId: "42", messageId: "7" }
const BATCH = { ...MESSAGE, proposalId: "17080", batchDigest: "d1", ownerUserId: "42" }

const open = async (now = () => 1_000_000) => {
  const path = join(mkdtempSync(join(tmpdir(), "decision-requests-")), "wirecat.db")
  return { path, store: await openStore({ path, now }) }
}

describe("callback data", () => {
  it("is wcr1 and a 22 character token, 27 bytes, and nothing else parses", async () => {
    const { store } = await open()
    try {
      const { confirm: token } = keysOf(store, { ...BATCH, actions: ["confirm"] })
      const data = callbackDataOf(token)
      expect(token).toHaveLength(22)
      expect(Buffer.byteLength(data)).toBe(27)
      expect(parseCallbackData(data)).toBe(token)
      for (const bad of [
        "",
        `${data}\n`,
        ` ${data}`,
        `${data}x`,
        data.slice(0, -1),
        data.replace("wcr1:", "wcr2:"),
        data.replace("wcr1:", "WCR1:"),
        `wcr1:${"A".repeat(21)}B`,
        `wcr1:${"A".repeat(20)}+A`,
        undefined,
        42,
      ])
        expect(parseCallbackData(bad)).toBeUndefined()
      expect(() => callbackDataOf("short")).toThrow(TypeError)
    } finally {
      await store.close()
    }
  })
})

describe("decision requests", () => {
  it("keeps only a digest, lists open buttons and hands out distinct tokens", async () => {
    const { path, store } = await open()
    try {
      const made = store.decisionRequests.create({ ...BATCH, actions: ["ask-confirm", "ask-reject", "later"] })
      expect(made.map((m) => m.action)).toEqual(["ask-confirm", "ask-reject", "later"])
      expect(new Set(made.map((m) => m.token)).size).toBe(3)
      expect(store.decisionRequests.open(MESSAGE).map((r) => r.action)).toEqual(["ask-confirm", "ask-reject", "later"])
      expect(store.decisionRequests.open({ ...MESSAGE, messageId: "8" })).toEqual([])
      const stored = JSON.stringify((await openCache(path)).prepare("SELECT * FROM decision_requests").all())
      for (const { token } of made) expect(stored).not.toContain(token)
    } finally {
      await store.close()
    }
  })

  it("takes a token once, cancels its siblings, and refuses a second use", async () => {
    const { store } = await open()
    try {
      const { confirm, reject, later } = keysOf(store, { ...BATCH, actions: ["confirm", "reject", "later"] })
      const taken = store.decisionRequests.take(confirm, { chatId: "42", messageId: "7", ownerUserId: "42" })
      expect(taken).toMatchObject({
        ok: true,
        cancelled: 2,
        request: { action: "confirm", proposalId: "17080", batchDigest: "d1" },
      })
      expect(store.decisionRequests.take(confirm)).toEqual({ ok: false, reason: "decision.token-used" })
      expect(store.decisionRequests.take(reject)).toEqual({ ok: false, reason: "decision.token-cancelled" })
      expect(store.decisionRequests.take(later)).toEqual({ ok: false, reason: "decision.token-cancelled" })
      expect(store.decisionRequests.open(MESSAGE)).toEqual([])
    } finally {
      await store.close()
    }
  })

  it("refuses an unknown, malformed or mismatched token, and a mismatch burns nothing", async () => {
    const { store } = await open()
    try {
      const only = keysOf(store, { ...BATCH, actions: ["confirm"] })
      expect(store.decisionRequests.take("A".repeat(22))).toEqual({ ok: false, reason: "decision.token-unknown" })
      expect(store.decisionRequests.take("nope")).toEqual({ ok: false, reason: "decision.token-unknown" })
      for (const expect_ of [{ ownerUserId: "43" }, { chatId: "43" }, { messageId: "8" }])
        expect(store.decisionRequests.take(only.confirm, expect_)).toEqual({
          ok: false,
          reason: "decision.token-mismatch",
        })
      expect(store.decisionRequests.take(only.confirm)).toMatchObject({ ok: true })
    } finally {
      await store.close()
    }
  })

  it("refuses an expired token at 72 hours", async () => {
    let at = 1_000_000
    const { store } = await open(() => at)
    try {
      const { confirm: early, later: late } = keysOf(store, { ...BATCH, actions: ["confirm", "later"] })
      at += DECISION_TTL_MS - 1
      expect(store.decisionRequests.open(MESSAGE)).toHaveLength(2)
      expect(store.decisionRequests.take(early)).toMatchObject({ ok: true })
      at += 1
      expect(store.decisionRequests.take(late)).toEqual({ ok: false, reason: "decision.token-cancelled" })
      const { confirm: fresh } = keysOf(store, { ...BATCH, messageId: "9", actions: ["confirm"] })
      at += DECISION_TTL_MS
      expect(store.decisionRequests.take(fresh)).toEqual({ ok: false, reason: "decision.token-expired" })
      expect(store.decisionRequests.open({ ...MESSAGE, messageId: "9" })).toEqual([])
    } finally {
      await store.close()
    }
  })

  it("cancels every open token for one bot, or for all, and leaves used ones as they were", async () => {
    const { store } = await open()
    try {
      const a = keysOf(store, { ...BATCH, actions: ["confirm", "reject"] })
      const b = keysOf(store, { ...BATCH, botProfile: "other", actions: ["later"] })
      store.decisionRequests.take(a.confirm)
      expect(store.decisionRequests.cancelOpen({ channel: "telegram", botProfile: "other" })).toBe(1)
      expect(store.decisionRequests.take(b.later)).toEqual({ ok: false, reason: "decision.token-cancelled" })
      const c = keysOf(store, { ...BATCH, messageId: "10", actions: ["confirm", "later"] })
      expect(store.decisionRequests.cancelOpen()).toBe(2)
      expect(store.decisionRequests.take(c.later)).toEqual({ ok: false, reason: "decision.token-cancelled" })
      expect(store.decisionRequests.cancelOpen()).toBe(0)
    } finally {
      await store.close()
    }
  })

  it("refuses an invalid request", async () => {
    const { store } = await open()
    try {
      expect(() => store.decisionRequests.create({ ...BATCH, actions: [] })).toThrow()
      expect(() => store.decisionRequests.create({ ...BATCH, actions: ["confirm", "confirm"] })).toThrow()
      expect(() => store.decisionRequests.create({ ...BATCH, actions: ["delete" as "confirm"] })).toThrow()
      expect(() => store.decisionRequests.create({ ...BATCH, chatId: "", actions: ["confirm"] })).toThrow()
      expect(store.decisionRequests.open(MESSAGE)).toEqual([])
    } finally {
      await store.close()
    }
  })
})

describe("store version 55", () => {
  it("gives a version 54 file the table", async () => {
    const { path, store } = await open()
    await store.close()
    const old = await openCache(path)
    rollBackTo(old, 55)
    expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'decision_requests'").get()).toBeUndefined()
    old.close()
    const upgraded = await openStore({ path })
    try {
      const made = keysOf(upgraded, { ...BATCH, actions: ["confirm"] })
      expect(upgraded.decisionRequests.take(made.confirm)).toMatchObject({ ok: true })
    } finally {
      await upgraded.close()
    }
  })
})
