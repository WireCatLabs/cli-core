import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { DEFAULT_HISTORY_LIMITS, limitBatch } from "./history-limits.js"

const now = Date.parse("2026-11-02T00:00:00Z")
const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString()
const message = (id: string, chatId: string, timestamp: string) => ({ id, chatId, timestamp }) as Message

describe("limitBatch", () => {
  it("keeps three years of a dialog, one of a group, and nothing of a group over the size", () => {
    const { batch, skipped } = limitBatch(
      {
        chats: [
          { id: "d", title: null, kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
          { id: "g", title: null, kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 12 },
          { id: "big", title: null, kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 214 },
        ],
        messages: [
          message("1", "d", daysAgo(800)),
          message("2", "d", daysAgo(1200)),
          message("3", "g", daysAgo(300)),
          message("4", "g", daysAgo(400)),
          message("5", "big", daysAgo(1)),
        ],
      },
      () => undefined,
      () => false,
      DEFAULT_HISTORY_LIMITS,
      now,
    )

    expect(batch.messages?.map((one) => one.id)).toEqual(["1", "3"])
    expect(batch.chats).toHaveLength(3)
    expect(Object.fromEntries([...skipped].map(([id, skip]) => [id, [skip.reason, skip.messages]]))).toEqual({
      d: ["older_than_window", 1],
      g: ["older_than_window", 1],
      big: ["group_too_large", 1],
    })
    expect(skipped.get("big")?.members).toBe(214)
  })

  it("keeps everything of a chat the owner lifted, and reads a chat the batch does not name from the store", () => {
    const { batch, skipped } = limitBatch(
      { messages: [message("1", "big", daysAgo(1)), message("2", "old", daysAgo(500))] },
      (chatId) =>
        chatId === "big" ? { kind: "group", participantsCount: 300 } : { kind: "group", participantsCount: 5 },
      (chatId) => chatId === "big",
      DEFAULT_HISTORY_LIMITS,
      now,
    )

    expect(batch.messages?.map((one) => one.id)).toEqual(["1"])
    expect([...skipped.keys()]).toEqual(["old"])
  })
})
