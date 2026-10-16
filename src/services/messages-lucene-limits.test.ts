import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { type MessageStore, openStore } from "../store/store.js"
import { searchStore } from "./messages-archive-search.js"

vi.mock("../search/lucene/types.js", async (original) => {
  const actual = await original<typeof import("../search/lucene/types.js")>()
  return { ...actual, QUERY_LIMITS: { ...actual.QUERY_LIMITS, candidates: 20 } }
})

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

it("finds a file name among more messages with files than the candidate row limit", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "lucene-limits-")), "messages.db") })
  live.push(store)
  const account = { provider: "max", account: "1" }
  await store.chats.saveChats(account, [
    { id: "1", title: "Chat 1", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.messages.saveMessages(
    account,
    "1",
    Array.from({ length: 21 }, (_, at) => ({
      id: String(at + 1),
      chatId: "1",
      senderId: "200",
      senderName: "alice",
      timestamp: new Date(Date.UTC(2026, 0, 1, 10, at)).toISOString(),
      editedAt: null,
      text: "",
      outgoing: false,
      attachments: [{ kind: "file", name: at === 20 ? "Final.PDF" : `scan-${at}.jpg` }],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    })),
    { via: "history" },
  )
  const run = (text: string) => searchStore(store, account, { text, limit: 100 })
  expect((await run("filename:*.pdf")).items.map(({ id }) => id)).toEqual(["21"])
  expect((await run("has:file AND NOT filename:*.jpg")).items).toHaveLength(1)
  await expect(run("body:/.*/")).rejects.toThrow("candidate rows")
})
