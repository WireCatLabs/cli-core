import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { type MessageStore, openStore } from "../store/store.js"
import { searchStore } from "./messages-archive-search.js"

const live: MessageStore[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of live.splice(0)) await store.close()
})

const storeWith = async (count: number) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "time-limit-")), "messages.db") })
  live.push(store)
  const account = { provider: "max", account: "1" }
  await store.chats.saveChats(account, [
    { id: "1", title: "Chat 1", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.messages.saveMessages(
    account,
    "1",
    Array.from({ length: count }, (_, at) => ({
      id: String(at + 1),
      chatId: "1",
      senderId: "200",
      senderName: "alice",
      timestamp: new Date(Date.UTC(2026, 0, 1, 10, at)).toISOString(),
      editedAt: null,
      text: `note ${at}`,
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    })),
    { via: "history" },
  )
  return { store, account }
}

it("stops a statement that runs past the time limit, as a timeout rather than a query problem", async () => {
  const { store, account } = await storeWith(200)
  const start = Date.now()
  let rowChecks = 0
  // Only the SQL function sees time leap, so it is the statement itself that stops, not a check between statements.
  vi.spyOn(Date, "now").mockImplementation(() => {
    if (!new Error().stack?.includes("beforeTimeLimit")) return start
    rowChecks += 1
    return start + 60_000
  })
  await expect(searchStore(store, account, { text: "in:max", limit: 300 })).rejects.toMatchObject({
    code: "timeout",
    message: expect.stringContaining("time limit"),
    details: { reason: "query.time-limit", complete: false },
  })
  expect(rowChecks).toBe(1)
})

it("answers in time with the limit in every statement", async () => {
  const { store, account } = await storeWith(30)
  const found = await searchStore(store, account, { text: "in:max", limit: 50 })
  expect(found.items).toHaveLength(30)
})
