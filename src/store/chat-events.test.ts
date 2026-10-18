import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Chat, ChatEvent } from "../domain/models.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "whatsapp", account: "1@lid" }
const OTHER: AccountKey = { provider: "whatsapp", account: "2@lid" }
const PHONE = "120363000000001@g.us"
const LID = "120363000000002@g.us"

const group = (id: string): Chat => ({
  id,
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
})

const event = (id: string, at: string, action = "join", people = ["11"]): ChatEvent => ({
  messageId: id,
  timestamp: at,
  event: action,
  by: { id: "9", name: "Olga" },
  people: people.map((person) => ({ id: person, name: `Person ${person}` })),
})

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const fresh = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "chat-events-")), "wirecat.db")
  const store = await openStore({ path })
  opened.push(store)
  return { store, path }
}

const ids = async (store: MessageStore, key: AccountKey, chatId: string, options = {}) =>
  (await store.roster.chatEvents(key, chatId, options)).map((one) => one.messageId)

const rows = async (path: string, table: string) => {
  const database = await openCache(path)
  try {
    return Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n)
  } finally {
    database.close()
  }
}

describe("chat events in the store", () => {
  it("**keeps them to the account**: another account's chat with the same id holds none", async () => {
    const { store } = await fresh()
    await store.roster.saveChatEvents(OWNER, PHONE, [event("e1", "2026-10-18T10:00:00.000Z")])

    expect(await ids(store, OWNER, PHONE)).toEqual(["e1"])
    expect(await ids(store, OTHER, PHONE)).toEqual([])
    expect(await store.forAccount(OTHER).roster.chatEvents(PHONE)).toEqual([])
    expect(await store.forAccount(OWNER).roster.chatEvents(PHONE)).toHaveLength(1)
  })

  it("reads oldest first from `since`, and only the newest `limit`", async () => {
    const { store } = await fresh()
    await store.roster.saveChatEvents(OWNER, PHONE, [
      event("e3", "2026-10-18T12:00:00.000Z"),
      event("e1", "2026-10-18T10:00:00.000Z"),
      event("e2", "2026-10-18T11:00:00.000Z"),
    ])

    expect(await ids(store, OWNER, PHONE)).toEqual(["e1", "e2", "e3"])
    expect(await ids(store, OWNER, PHONE, { since: "2026-10-18T11:00:00.000Z" })).toEqual(["e2", "e3"])
    expect(await ids(store, OWNER, PHONE, { limit: 2 })).toEqual(["e2", "e3"])
  })

  it("**a replay adds only a person the stored event lacked**", async () => {
    const { store } = await fresh()
    await store.roster.saveChatEvents(OWNER, PHONE, [event("e1", "2026-10-18T10:00:00.000Z", "add", ["11"])])
    await store.roster.saveChatEvents(OWNER, PHONE, [event("e1", "2026-10-18T10:00:00.000Z", "add", ["11", "12"])])

    const [held] = await store.roster.chatEvents(OWNER, PHONE)
    expect(held?.people.map((one) => one.id)).toEqual(["11", "12"])
    expect(held?.by).toEqual({ id: "9", name: "Olga" })
  })

  it("**follow a chat re-keyed into another**, the same event held once", async () => {
    const { store } = await fresh()
    await store.chats.saveChats(OWNER, [group(PHONE), group(LID)])
    await store.roster.saveChatEvents(OWNER, PHONE, [
      event("e1", "2026-10-18T10:00:00.000Z"),
      event("e2", "2026-10-18T11:00:00.000Z"),
    ])
    await store.roster.saveChatEvents(OWNER, LID, [event("e2", "2026-10-18T11:00:00.000Z")])

    expect((await store.chats.rekeyChat(OWNER, PHONE, LID)).outcome).toBe("merged")

    expect(await ids(store, OWNER, LID)).toEqual(["e1", "e2"])
    expect(await ids(store, OWNER, PHONE)).toEqual([])
  })

  it("go with the account when it is purged", async () => {
    const { store, path } = await fresh()
    await store.roster.saveChatEvents(OWNER, PHONE, [event("e1", "2026-10-18T10:00:00.000Z", "add", ["11", "12"])])

    await store.accounts.purge(OWNER)

    expect(await rows(path, "chat_events")).toBe(0)
    expect(await rows(path, "chat_event_people")).toBe(0)
  })
})
