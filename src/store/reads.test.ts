import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { QueryAst } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import { listQuery } from "../cli/list-query.js"
import { CHATS_QUERY } from "../cli/messenger/chat-queries.js"
import type { Chat, Message } from "../domain/models.js"
import { type AccountKey, CHAT_COLUMNS, openStore, queryFilter } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "reads-")), "messages.db")
const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "max", account: "2" }

const chat = (id: string, title: string, kind: Chat["kind"], unreadCount: number, lastMessageAt: string): Chat => ({
  id,
  title,
  kind,
  unreadCount,
  lastMessageAt,
  participantsCount: null,
})

const at = (minute: number) => new Date(Date.UTC(2026, 8, 30, 10, minute)).toISOString()

const message = (id: string, minute: number): Message => ({
  id,
  chatId: "-1",
  senderId: "7",
  senderName: "Ana",
  timestamp: at(minute),
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

describe("filtered chat lists", () => {
  it("**filter by a query over title, kind and unread_count, and count the same filter**", async () => {
    const store = await openStore({ path: fresh() })
    await store.saveChats(OWNER, [
      chat("-1", "Valencia expats", "group", 3, at(5)),
      chat("-2", "València runners", "group", 0, at(9)),
      chat("7", "Ana", "dialog", 1, at(7)),
      chat("-4", "Книжный клуб", "channel", 0, at(1)),
    ])
    await store.saveChats(OTHER, [chat("-3", "Valencia market", "group", 2, at(1))])
    const where = (text: string) =>
      queryFilter(listQuery(text, CHATS_QUERY, "chats list") as QueryAst, CHAT_COLUMNS, { command: "chats list" })
    const ids = async (text: string, limit?: number) =>
      (await store.chats(OWNER, { where: where(text), ...(limit ? { limit } : {}) })).items.map(({ id }) => id)

    expect(await ids("title:lencia")).toEqual(["-1"])
    expect(await ids("title:*LENCIA*")).toEqual(["-1"])
    expect(await ids("title:книж")).toEqual(["-4"])
    expect(await ids("title:КНИЖ")).toEqual(["-4"])
    expect(await ids("kind:group")).toEqual(["-2", "-1"])
    expect(await ids("unread_count>0")).toEqual(["7", "-1"])
    expect(await ids("kind:group unread_count>0", 5)).toEqual(["-1"])
    expect(await ids("-kind:group")).toEqual(["7", "-4"])
    expect(await store.countChats(OWNER, { where: where("unread_count>0") })).toBe(2)
    expect(await store.countChats(OWNER)).toBe(4)
    expect(await store.countChats(OTHER, { where: where("title:lencia") })).toBe(1)
    expect(() => where("title:va")).toThrow(/at least 3 characters/)
    await store.close()
  })
})

describe("messages by time", () => {
  const seeded = async () => {
    const store = await openStore({ path: fresh() })
    await store.saveMessages(
      OWNER,
      "-1",
      [1, 2, 3, 4, 5].map((n) => message(String(n), n * 10)),
      { via: "history" },
    )
    await store.markDeleted(OWNER, ["3"], { chatId: "-1" })
    return store
  }
  const ids = (messages: Message[]) => messages.map(({ id }) => id)

  it("**a window around a moment**: some at or before it, some after, oldest first, deleted left out", async () => {
    const store = await seeded()

    expect(ids(await store.messagesWindow(OWNER, "-1", { at: at(30), before: 2, after: 2 }))).toEqual([
      "1",
      "2",
      "4",
      "5",
    ])
    expect(ids(await store.messagesWindow(OWNER, "-1", { at: at(20), before: 1, after: 1 }))).toEqual(["2", "4"])
    expect(await store.messagesWindow(OTHER, "-1", { at: at(30), before: 5, after: 5 })).toEqual([])
    await store.close()
  })

  it("pages and counts the messages sent since a moment", async () => {
    const store = await seeded()

    const page = await store.messages(OWNER, "-1", { limit: 1, since: at(20) })
    expect(ids(page.items)).toEqual(["5"])
    expect(page.hasMore).toBe(true)
    expect(ids((await store.messages(OWNER, "-1", { limit: 10, since: at(20) })).items)).toEqual(["2", "4", "5"])
    expect(await store.countMessages(OWNER, "-1", { since: at(20) })).toBe(3)
    expect(await store.countMessages(OWNER, "-1")).toBe(4)
    expect(await store.countMessages(OTHER, "-1")).toBe(0)
    await store.close()
  })
})
