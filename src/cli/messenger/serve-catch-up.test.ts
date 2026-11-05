import { CliError } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { Chat } from "../../domain/models.js"
import { startSync } from "./serve-catch-up.js"
import type { ServeNotice } from "./serve-notice.js"

const NOW = Date.parse("2026-11-02T12:00:00.000Z")
const at = (iso: string) => Date.parse(iso)
const chat = (id: string, lastMessageAt: string | null): Chat => ({
  id,
  title: null,
  kind: "group",
  unreadCount: 0,
  lastMessageAt,
  participantsCount: 1,
})
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const passOver = (
  listed: Chat[],
  held: Record<string, string>,
  fetch: (chatId: string, sinceMs: number, stop: AbortSignal) => Promise<{ fetched: number }>,
  budgetMs = 60_000,
) => {
  const notes: ServeNotice[] = []
  const warnings: ServeNotice[] = []
  const sync = startSync({
    chats: async () => listed,
    newestHeld: async (chatId) => (held[chatId] === undefined ? undefined : at(held[chatId])),
    fetch,
    note: (notice) => notes.push(notice),
    warn: (notice) => warnings.push(notice),
    delayMs: 1,
    budgetMs,
    now: () => NOW,
  })
  return { sync, notes, warnings }
}

describe("serve's catch-up on start", () => {
  it("reads back each chat that moved to its newest held message, a chat never held to the newest held anywhere", async () => {
    const asked: [string, string][] = []
    const { sync, notes } = passOver(
      [
        chat("behind", "2026-11-02T10:00:00.000Z"),
        chat("current", "2026-11-01T08:00:00.000Z"),
        chat("new", "2026-11-02T11:00:00.000Z"),
        chat("quiet", "2026-11-01T07:00:00.000Z"),
        chat("old", "2026-10-01T09:00:00.000Z"),
        chat("undated", null),
      ],
      { behind: "2026-11-01T06:00:00.000Z", current: "2026-11-01T08:00:00.000Z", old: "2026-09-01T00:00:00.000Z" },
      async (chatId, sinceMs) => {
        asked.push([chatId, new Date(sinceMs).toISOString()])
        return { fetched: 3 }
      },
    )

    sync.start()
    sync.start()
    await settle(30)
    await sync.stop()

    expect(asked).toEqual([
      ["new", "2026-11-01T08:00:00.000Z"],
      ["behind", "2026-11-01T06:00:00.000Z"],
    ])
    expect(sync.summary()).toEqual({ chats: 2, fetched: 6, failed: 0, stopped: false })
    expect(notes.map(({ code }) => code)).toEqual(["start_sync"])
  })

  it("leaves an empty store to a full sync and fetches nothing", async () => {
    const asked: string[] = []
    const { sync, notes } = passOver([chat("7", "2026-11-02T10:00:00.000Z")], {}, async (chatId) => {
      asked.push(chatId)
      return { fetched: 1 }
    })

    sync.start()
    await settle(30)
    await sync.stop()

    expect(asked).toEqual([])
    expect(sync.summary()).toBeUndefined()
    expect(notes).toEqual([])
  })

  it("goes on past a chat that fails, and says which by id", async () => {
    const { sync, warnings } = passOver(
      [chat("7", "2026-11-02T10:00:00.000Z"), chat("8", "2026-11-02T09:00:00.000Z")],
      { 7: "2026-11-02T08:00:00.000Z", 8: "2026-11-02T08:00:00.000Z" },
      async (chatId) => {
        if (chatId === "7") throw new CliError("rate_limited", "flood wait")
        return { fetched: 2 }
      },
    )

    sync.start()
    await settle(30)
    await sync.stop()

    expect(sync.summary()).toEqual({ chats: 1, fetched: 2, failed: 1, stopped: false })
    expect(warnings).toEqual([expect.objectContaining({ code: "start_sync_chat_failed", chatId: "7" })])
  })

  it("stops at its time budget and says how many chats are left", async () => {
    const { sync, notes, warnings } = passOver(
      [chat("7", "2026-11-02T10:00:00.000Z"), chat("8", "2026-11-02T09:00:00.000Z")],
      { 7: "2026-11-02T08:00:00.000Z", 8: "2026-11-02T08:00:00.000Z" },
      (_chatId, _sinceMs, stop) =>
        new Promise((_resolve, reject) => stop.addEventListener("abort", () => reject(stop.reason), { once: true })),
      20,
    )

    sync.start()
    await settle(80)
    await sync.stop()

    expect(sync.summary()).toEqual({ chats: 0, fetched: 0, failed: 0, stopped: true })
    expect(warnings).toEqual([])
    expect(notes[0]?.text).toContain("2 left")
  })

  it("stops its time budget once the pass is done", async () => {
    let seen: AbortSignal | undefined
    const { sync } = passOver(
      [chat("7", "2026-11-02T10:00:00.000Z")],
      { 7: "2026-11-02T08:00:00.000Z" },
      async (_chatId, _sinceMs, stop) => {
        seen = stop
        return { fetched: 1 }
      },
      30,
    )

    sync.start()
    await settle(100)
    expect(seen?.aborted).toBe(false)
    await sync.stop()
  })

  it("does nothing when serve stops before the pass begins", async () => {
    const asked: string[] = []
    const { sync } = passOver(
      [chat("7", "2026-11-02T10:00:00.000Z")],
      { 7: "2026-11-02T08:00:00.000Z" },
      async (chatId) => {
        asked.push(chatId)
        return { fetched: 1 }
      },
    )

    sync.start()
    await sync.stop()
    await settle(20)

    expect(asked).toEqual([])
    expect(sync.summary()).toBeUndefined()
  })
})
