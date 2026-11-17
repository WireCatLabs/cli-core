import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("gives a version 68 file a place for counted readiness, dropped when a chat's messages change", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-69-")), "wirecat.db")
  const account = { provider: "test", account: "1" }
  const store = await openStore({ path })
  await store.chats.saveChats(account, [
    { id: "9", title: "Chat", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 69)
  expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'conversation_readiness'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  await upgraded.close()
  const file = await openCache(path)
  try {
    const chat = file.prepare("SELECT id FROM chats").get() as { id: number }
    file
      .prepare(
        `INSERT INTO conversation_readiness (chat_id, model, new_count, edited_count, deleted_count, chunks,
          embedded_count, current, stale, counted_at) VALUES (?, 'm', 0, 0, 0, 0, 0, 0, 0, 1)`,
      )
      .run(chat.id)
    file.prepare("INSERT INTO conversation_state (chat_id, enabled_at) VALUES (?, 1)").run(chat.id)
    expect(file.prepare("SELECT count(*) AS n FROM conversation_readiness").get()).toEqual({ n: 0 })
  } finally {
    file.close()
  }
})
