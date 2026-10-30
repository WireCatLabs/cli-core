import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { Message } from "../domain/models.js"
import { historyStartKey, type MessageStore, openStore } from "../store/store.js"
import { chatCoverage } from "./chat-coverage.js"

const account = { provider: "chat", account: "500" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const said = (chatId: string, id: number): Message => ({
  id: String(id),
  chatId,
  senderId: "9",
  senderName: "Ana",
  timestamp: `2026-09-${String(10 + id).padStart(2, "0")}T10:00:00.000Z`,
  editedAt: null,
  text: `synthetic ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const chat = (id: string, lastMessageAt: string | null = null) => ({
  id,
  title: `Chat ${id}`,
  kind: "group" as const,
  unreadCount: 0,
  lastMessageAt,
  participantsCount: 3,
})

const seeded = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "coverage-")), "m.db") })
  opened.push(store)
  await store.chats.saveChats(
    account,
    ["never", "partial", "gaps", "whole"].map((id) => chat(id)),
  )
  for (const id of ["partial", "gaps", "whole"])
    await store.messages.saveMessages(
      account,
      id,
      [1, 2, 3, 4].map((n) => said(id, n)),
      { via: "test" },
    )
  await store.sync.markRange(account, "partial", 2, 4)
  await store.sync.markRange(account, "gaps", 1, 1)
  await store.sync.markRange(account, "gaps", 3, 4)
  await store.sync.markRange(account, "whole", 1, 4)
  await store.sync.setSyncState(account, historyStartKey("whole"), "1")
  return store
}

it("says per chat what the store holds and how far that goes, in the order asked", async () => {
  const store = await seeded()
  const rows = await chatCoverage(store, account, ["whole", "never", "partial", "gaps", "absent"])
  expect(rows.map(({ chatId, completeness }) => [chatId, completeness.state, completeness.gaps])).toEqual([
    ["whole", "complete", false],
    ["never", "unknown", false],
    ["partial", "partial", false],
    ["gaps", "partial", true],
    ["absent", "unknown", false],
  ])
  expect(rows[2]?.held).toEqual({
    messages: 4,
    oldestAt: "2026-09-11T10:00:00.000Z",
    newestAt: "2026-09-14T10:00:00.000Z",
  })
  expect(rows[1]?.held).toEqual({ messages: 0, oldestAt: null, newestAt: null })
  expect(JSON.stringify(rows)).not.toContain("synthetic")
})

it("calls a chat behind when the chat list holds a newer message than the store", async () => {
  const store = await seeded()
  await store.chats.saveChats(account, [chat("whole", "2026-10-20T10:00:00.000Z")])
  const [row] = await chatCoverage(store, account, ["whole"])
  expect(row?.completeness).toMatchObject({ state: "partial", upToDate: false, reachesStart: true })
})

it("reads only the chats asked for, however many the store holds", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "coverage-")), "m.db") })
  opened.push(store)
  const ids = Array.from({ length: 2_000 }, (_, index) => String(index))
  await store.chats.saveChats(
    account,
    ids.map((id) => chat(id)),
  )
  const stats = vi.spyOn(store.chats, "chatStats")
  const completeness = vi.spyOn(store.chats, "chatCompleteness")
  const wanted = ids.slice(0, 16)

  expect(await chatCoverage(store, account, wanted)).toHaveLength(16)
  expect(completeness).toHaveBeenCalledExactlyOnceWith(account, wanted)
  expect(stats.mock.calls.map(([, chatId]) => chatId)).toEqual(wanted)
})
