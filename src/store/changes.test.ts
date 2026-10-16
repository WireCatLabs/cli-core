import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { type AccountKey, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "max", account: "1" }

const message = (id: string, text: string, sent = "2025-01-01T10:00:00.000Z"): Message => ({
  id,
  chatId: "-1",
  senderId: "7",
  senderName: "Ana",
  timestamp: sent,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

describe("what changed after a mark", () => {
  it("takes new and edited messages by when this machine saw them, and deleted ids without text", async () => {
    let clock = Date.parse("2026-10-01T10:00:00Z")
    const store = await openStore({
      path: join(mkdtempSync(join(tmpdir(), "changes-")), "messages.db"),
      now: () => clock,
    })
    await store.messages.saveMessages(OWNER, "-1", [message("1", "old"), message("2", "kept"), message("3", "gone")], {
      via: "history",
    })
    const mark = new Date(clock).toISOString()

    clock += 60_000
    await store.messages.saveMessages(OWNER, "-1", [message("1", "old, edited a year later")], { via: "update" })
    await store.messages.saveMessages(OWNER, "-1", [message("4", "new", "2026-10-01T10:01:00.000Z")], { via: "update" })
    await store.messages.markDeleted(OWNER, ["3"], { chatId: "-1" })

    const { messages, deleted } = await store.messages.changes(OWNER, "-1", mark)

    expect(messages.map((one) => [one.id, one.text])).toEqual([
      ["1", "old, edited a year later"],
      ["4", "new"],
    ])
    expect(deleted).toEqual(["3"])
    expect(await store.messages.changes(OWNER, "-1", new Date(clock).toISOString())).toEqual({
      messages: [],
      deleted: [],
    })
    expect(await store.messages.changes(OWNER, "-404", mark)).toEqual({ messages: [], deleted: [] })
    await store.close()
  })
})
