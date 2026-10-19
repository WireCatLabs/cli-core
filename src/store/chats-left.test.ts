import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "left-")), "messages.db")
const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "max", account: "2" }

const chat = (id: string): Chat => ({
  id,
  title: `Chat ${id}`,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
})

const message = (id: string, chatId: string): Message => ({
  id,
  chatId,
  senderId: "7",
  senderName: "Vera",
  timestamp: "2026-09-26T10:00:00.000Z",
  editedAt: null,
  text: "hello",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const ids = async (store: Awaited<ReturnType<typeof openStore>>, key: AccountKey) =>
  (await store.chats.chats(key, {})).items.map((one) => one.id)

describe("a chat the account left", () => {
  it("is marked by a complete list, skipped by the reads, kept across a reopen, and unmarked on rejoining", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.chats.saveChats(OWNER, [chat("-1"), chat("-2")])
    await store.roster.saveMembers(OWNER, "-2", ["7"])

    expect(await store.chats.markChatsLeft(OWNER, ["-1"])).toBe(1)
    expect(await store.chats.markChatsLeft(OWNER, ["-1"])).toBe(0)
    expect(await ids(store, OWNER)).toEqual(["-1"])
    expect(await store.chats.countChats(OWNER)).toBe(1)
    expect(await store.chats.chatsWith(OWNER, "7")).toEqual([])
    await store.close()

    const reopened = await openStore({ path })
    expect(await ids(reopened, OWNER)).toEqual(["-1"])
    expect(await reopened.chats.markChatsLeft(OWNER, ["-1", "-2"])).toBe(0)
    expect((await ids(reopened, OWNER)).sort()).toEqual(["-1", "-2"])
    await reopened.close()
  })

  it("stays left through a save that leaves membership out, such as a community notice", async () => {
    const store = await openStore({ path: fresh() })
    await store.chats.saveChats(OWNER, [chat("-1"), chat("-2")])
    await store.chats.markChatsLeft(OWNER, ["-1"])

    await store.chats.saveChats(OWNER, [{ id: "-2", kind: "group", parentChatId: "-9" }])
    await store.chats.saveChats(OWNER, [chat("-2")])

    expect(await store.chats.leftChats(OWNER)).toEqual({
      chats: 1,
      messages: 0,
      left: [{ id: "-2", title: "Chat -2", messages: 0 }],
    })
    await store.close()
  })

  it("changes only by an explicit value, and null takes the mark off", async () => {
    const store = await openStore({ path: fresh() })
    await store.chats.saveChats(OWNER, [chat("-1")])

    await store.chats.saveChats(OWNER, [{ id: "-1", kind: "group", membershipState: "left" }])
    expect(await ids(store, OWNER)).toEqual([])
    await store.chats.saveChats(OWNER, [{ id: "-1", kind: "group", membershipState: "archived" }])
    await store.chats.saveChats(OWNER, [chat("-1")])
    await store.chats.markChatsLeft(OWNER, ["-1"])
    expect((await store.chats.chats(OWNER, {})).items[0]?.membershipState).toBe("archived")
    await store.chats.saveChats(OWNER, [{ id: "-1", kind: "group", membershipState: "left" }])
    await store.chats.saveChats(OWNER, [{ id: "-1", kind: "group", membershipState: null }])
    expect((await store.chats.chats(OWNER, {})).items).toEqual([chat("-1")])
    await store.close()
  })

  it("is taken off the chats any part of a chat list names, keeping other states", async () => {
    const store = await openStore({ path: fresh() })
    await store.chats.saveChats(OWNER, [chat("-1"), chat("-2"), chat("-3")])
    await store.chats.markChatsLeft(OWNER, [])
    await store.chats.saveChats(OWNER, [{ id: "-3", kind: "group", membershipState: "archived" }])

    expect(await store.chats.rejoinChats(OWNER, ["-1", "-3"])).toBe(1)
    expect((await store.chats.chats(OWNER, {})).items.map((one) => [one.id, one.membershipState ?? null])).toEqual([
      ["-1", null],
      ["-3", "archived"],
    ])
    await store.close()
  })

  it("is marked per account", async () => {
    const store = await openStore({ path: fresh() })
    await store.chats.saveChats(OWNER, [chat("-1"), chat("-2")])
    await store.chats.saveChats(OTHER, [chat("-2")])

    await store.chats.markChatsLeft(OWNER, ["-1"])

    expect(await ids(store, OTHER)).toEqual(["-2"])
    await store.close()
  })

  it("is taken off per account", async () => {
    const store = await openStore({ path: fresh() })
    await store.chats.saveChats(OWNER, [chat("-1")])
    await store.chats.saveChats(OTHER, [chat("-1")])
    await store.chats.markChatsLeft(OWNER, [])
    await store.chats.markChatsLeft(OTHER, [])

    expect(await store.chats.rejoinChats(OWNER, ["-1"])).toBe(1)

    expect(await ids(store, OWNER)).toEqual(["-1"])
    expect(await ids(store, OTHER)).toEqual([])
    await store.close()
  })

  it("is counted, then deleted with its messages and members, and nothing else is", async () => {
    const store = await openStore({ path: fresh() })
    await store.chats.saveChats(OWNER, [chat("-1"), chat("-2")])
    await store.messages.saveMessages(OWNER, "-1", [message("10", "-1")], { via: "history" })
    await store.messages.saveMessages(OWNER, "-2", [message("20", "-2"), message("21", "-2")], { via: "history" })
    await store.roster.saveMembers(OWNER, "-2", ["7"])
    await store.chats.markChatsLeft(OWNER, ["-1"])

    const left = { chats: 1, messages: 2, left: [{ id: "-2", title: "Chat -2", messages: 2 }] }
    expect(await store.chats.leftChats(OWNER)).toEqual(left)
    expect(await store.chats.leftChats(OWNER, { clear: true })).toEqual(left)
    expect(await store.chats.leftChats(OWNER)).toEqual({ chats: 0, messages: 0, left: [] })
    expect(await store.messages.message(OWNER, "20")).toBeUndefined()
    expect(await store.messages.message(OWNER, "10")).toBeDefined()
    expect(await store.roster.members(OWNER, "-2")).toEqual([])
    await store.close()
  })
})
