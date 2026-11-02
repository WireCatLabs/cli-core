import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ChatKind, Message } from "../domain/models.js"
import { openStore } from "../store/store.js"
import { acknowledgeTaskAnalysis, taskAnalysisList, unanalysedMessages } from "./task-analysis.js"

const account = { provider: "telegram", account: "500" } as const
const other = { provider: "telegram", account: "600" } as const
const now = new Date(Date.UTC(2026, 9, 10))
const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 10, minute)).toISOString()

const said = (id: string, minute: number, chatId = "-1001"): Message => ({
  id,
  chatId,
  senderId: "9",
  senderName: null,
  timestamp: at(minute),
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const storeWith = async (chats: { id: string; kind: ChatKind; messages: Message[] }[], key = account) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-analysis-")), "messages.db") })
  for (const chat of chats) {
    await store.chats.saveChats(key, [
      { id: chat.id, title: chat.id, kind: chat.kind, unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.messages.saveMessages(key, chat.id, chat.messages, { via: "test" })
  }
  return store
}

const ids = (messages: Message[]) => messages.map((one) => one.id)

describe("task analysis marks", () => {
  it("reads what was never read for tasks, and only acknowledging moves the chat's mark", async () => {
    const store = await storeWith([{ id: "-1001", kind: "dialog", messages: [said("1", 1), said("2", 2)] }])

    expect((await unanalysedMessages(store, account, "-1001", { now })).messages.map((one) => one.id)).toEqual([
      "1",
      "2",
    ])
    expect(ids((await unanalysedMessages(store, account, "-1001", { now })).messages)).toEqual(["1", "2"])

    const { moved, mark } = await acknowledgeTaskAnalysis(store, account, "-1001", "2", { by: "agent", now })
    expect(moved).toBe(true)
    expect(mark).toMatchObject({ through: at(2), throughId: "2", by: "agent", checkedThrough: at(2) })

    await store.messages.saveMessages(account, "-1001", [said("3", 3)], { via: "test" })
    const next = await unanalysedMessages(store, account, "-1001", { now })
    expect(ids(next.messages)).toEqual(["3"])
    expect(next.late).toBe(0)
    expect(await taskAnalysisList(store, account, now)).toEqual([
      expect.objectContaining({ chatId: "-1001", waiting: 1, late: 0 }),
    ])
    await store.close()
  })

  it("pages a long backlog and never moves the mark back", async () => {
    const store = await storeWith([
      { id: "-1001", kind: "dialog", messages: [said("1", 1), said("2", 2), said("3", 3)] },
    ])
    const first = await unanalysedMessages(store, account, "-1001", { limit: 2, now })
    expect([ids(first.messages), first.more]).toEqual([["1", "2"], true])
    await acknowledgeTaskAnalysis(store, account, "-1001", "2", { by: "agent", now })

    expect((await acknowledgeTaskAnalysis(store, account, "-1001", "1", { by: "agent", now })).moved).toBe(false)
    const rest = await unanalysedMessages(store, account, "-1001", { limit: 2, now })
    expect([ids(rest.messages), rest.more]).toEqual([["3"], false])
    await store.close()
  })

  it("counts history fetched later inside the read stretch, until the stretch is read again", async () => {
    const store = await storeWith([{ id: "-1001", kind: "dialog", messages: [said("1", 1), said("4", 4)] }])
    await acknowledgeTaskAnalysis(store, account, "-1001", "4", { by: "agent", now })
    await new Promise((resolve) => setTimeout(resolve, 5))

    await store.messages.saveMessages(account, "-1001", [said("2", 2)], { via: "backfill" })
    expect((await unanalysedMessages(store, account, "-1001", { now })).late).toBe(1)
    await store.messages.saveMessages(account, "-1001", [said("5", 5)], { via: "test" })
    await acknowledgeTaskAnalysis(store, account, "-1001", "5", { by: "agent", now })
    expect((await taskAnalysisList(store, account, now))[0]).toMatchObject({ waiting: 0, late: 1 })

    const mark = await store.sync.taskAnalysisMark(account, "-1001")
    const again = await unanalysedMessages(store, account, "-1001", { since: mark?.from, now })
    expect(ids(again.messages)).toEqual(["1", "2", "4", "5"])
    await acknowledgeTaskAnalysis(store, account, "-1001", "5", { since: mark?.from, by: "agent", now })
    expect((await taskAnalysisList(store, account, now))[0]).toMatchObject({ waiting: 0, late: 0 })
    await store.close()
  })

  it("leaves late messages counted when a read again stops before the point", async () => {
    const store = await storeWith([{ id: "-1001", kind: "dialog", messages: [said("1", 1), said("4", 4)] }])
    await acknowledgeTaskAnalysis(store, account, "-1001", "4", { by: "agent", now })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.messages.saveMessages(account, "-1001", [said("2", 2), said("3", 3)], { via: "backfill" })
    const mark = await store.sync.taskAnalysisMark(account, "-1001")

    const again = await unanalysedMessages(store, account, "-1001", { since: mark?.from, limit: 2, now })
    expect([ids(again.messages), again.more]).toEqual([["1", "2"], true])
    const acknowledged = await acknowledgeTaskAnalysis(store, account, "-1001", "2", {
      since: mark?.from,
      by: "agent",
      now,
    })
    expect(acknowledged.moved).toBe(false)
    expect((await taskAnalysisList(store, account, now))[0]).toMatchObject({ late: 2 })
    await store.close()
  })

  it("keeps each account's marks apart and lists no channel", async () => {
    const store = await storeWith([
      { id: "-1001", kind: "dialog", messages: [said("1", 1)] },
      { id: "-2002", kind: "channel", messages: [said("1", 1, "-2002")] },
    ])
    await store.chats.saveChats(other, [
      { id: "-1001", title: "-1001", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.messages.saveMessages(other, "-1001", [said("1", 1)], { via: "test" })

    await acknowledgeTaskAnalysis(store, account, "-1001", "1", { by: "agent", now })
    expect((await taskAnalysisList(store, account, now)).map(({ chatId, waiting }) => [chatId, waiting])).toEqual([
      ["-1001", 0],
    ])
    expect(await taskAnalysisList(store, other, now)).toEqual([
      expect.objectContaining({ chatId: "-1001", mark: null, waiting: 1 }),
    ])
    await store.close()
  })

  it("refuses a message the store does not hold", async () => {
    const store = await storeWith([{ id: "-1001", kind: "dialog", messages: [said("1", 1)] }])
    await expect(acknowledgeTaskAnalysis(store, account, "-1001", "9", { by: "agent", now })).rejects.toThrow(
      /not in the local copy/,
    )
    await store.close()
  })
})
