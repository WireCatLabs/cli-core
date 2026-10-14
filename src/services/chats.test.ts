import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { Chat } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { type MessageStore, openStore } from "../store/store.js"
import { chatsService } from "./chats.js"
import { onlineDeps, storedDeps } from "./deps.js"
import { peopleService } from "./people.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", chatArgument: "a chat" } as Messenger
const guard = {} as SendGuard

const chatOf = (id: string, title: string, kind: Chat["kind"], unreadCount: number, minute: number): Chat => ({
  id,
  title,
  kind,
  unreadCount,
  lastMessageAt: `2026-09-27T10:0${minute}:00.000Z`,
  participantsCount: kind === "dialog" ? 2 : 4,
})
const chats = [
  chatOf("7", "Book club", "group", 2, 3),
  chatOf("8", "Olga", "dialog", 0, 2),
  chatOf("9", "Anton", "dialog", 1, 1),
]

const people = [
  { id: "500", name: "Me" },
  { id: "21", name: "Olga" },
  { id: "22", name: "Anton" },
  { id: "23", name: "Boris" },
]

const opened: MessageStore[] = []
const keptStore = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "services-")), "m.db") })
  opened.push(store)
  await store.saveChats(account, chats)
  return store
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

describe("the chats service", () => {
  it("passes the window to the messenger and filters nothing itself", async () => {
    const asked: unknown[] = []
    const adapter = {
      self: () => "500",
      chats: async (window: unknown) => {
        asked.push(window)
        return { items: chats.slice(0, 1), hasMore: true }
      },
    }
    const service = chatsService(onlineDeps(messenger, adapter as unknown as MessengerAdapter, guard))

    expect(await service.list({ limit: 1, offset: 0 })).toEqual({ items: [chats[0]], hasMore: true })
    expect(asked).toEqual([{ limit: 1, offset: 0 }])
  })

  it("refuses a read the messenger's server cannot answer when its adapter has no server reads", async () => {
    const adapter = { self: () => "500" }
    const deps = onlineDeps(messenger, adapter as unknown as MessengerAdapter, guard)

    await expect(chatsService(deps).list({ offset: 0 })).rejects.toMatchObject({
      code: "validation_error",
      message: "this messenger cannot list chats",
    })
    await expect(peopleService(deps).show("Olga")).rejects.toMatchObject({
      message: "this messenger cannot show a person",
    })
  })

  it("refuses the reads only the messenger can answer offline", async () => {
    const service = chatsService(storedDeps(messenger, await keptStore(), account, guard))

    await expect(service.events("7", {})).rejects.toThrow(/`chats events` reads the chat's history/)
  })

  it("shows a stored chat offline with its saved members, leaving out the account itself", async () => {
    const store = await keptStore()
    await store.applyDelta(account, { people, members: new Map([["7", ["500", "21", "22"]]]) })
    const service = chatsService(storedDeps(messenger, store, account, guard))

    const card = await service.show("Book")

    expect(card.id).toBe("7")
    expect(card.members?.map((one) => one.name)).toEqual(["Anton", "Olga"])
  })

  it("says the members are unknown, not that there are none, when no list was saved", async () => {
    const service = chatsService(storedDeps(messenger, await keptStore(), account, guard))

    expect((await service.show("7")).members).toBeNull()
  })

  it("adds the saved members to a card the messenger gave without them", async () => {
    const store = await keptStore()
    await store.applyDelta(account, { people, members: new Map([["7", ["21"]]]) })
    const adapter = { self: () => "500", chat: async () => ({ ...chats[0], members: null }) }
    const service = chatsService({
      ...onlineDeps(messenger, adapter as unknown as MessengerAdapter, guard),
      store: async () => store,
    })

    expect((await service.show("7")).members?.map((one) => one.id)).toEqual(["21"])
  })
})

describe("the people service", () => {
  it("lists the people of the one-to-one chats kept in the store, by name", async () => {
    const service = peopleService(storedDeps(messenger, await keptStore(), account, guard))

    const found = await service.list({ order: "name", offset: 0 })

    expect(found.items.map((one) => one.name)).toEqual(["Anton", "Olga"])
  })

  it("lists the people the saved one-to-one member lists name, newest conversation first", async () => {
    const store = await keptStore()
    await store.applyDelta(account, {
      people,
      members: new Map([
        ["8", ["500", "21"]],
        ["9", ["500", "22"]],
        ["7", ["500", "21", "22", "23"]],
      ]),
    })
    const service = peopleService(storedDeps(messenger, store, account, guard))

    const found = await service.list({ order: "recent", offset: 0 })

    expect(found.items.map((one) => one.name)).toEqual(["Olga", "Anton"])
  })

  it("asks the store after the messenger's chats, so a login that brings the people counts", async () => {
    const store = await keptStore()
    const login = async () => {
      await store.applyDelta(account, { people, members: new Map([["8", ["500", "21"]]]) })
      return { items: chats, hasMore: false }
    }
    const adapter = { self: () => "500", chats: login }
    const service = peopleService({
      ...onlineDeps(messenger, adapter as unknown as MessengerAdapter, guard),
      store: async () => store,
    })

    const found = await service.list({ order: "name", offset: 0 })

    expect(found.items.map((one) => one.id)).toEqual(["21"])
  })

  it("lists the dialogs online when the store does not know whose account this is yet", async () => {
    const adapter = { self: () => null, chats: async () => ({ items: chats, hasMore: false }) }
    const service = peopleService({
      ...onlineDeps(messenger, adapter as unknown as MessengerAdapter, guard),
      store: async () => keptStore(),
    })

    const found = await service.list({ order: "name", offset: 0 })

    expect(found.items.map((one) => one.name)).toEqual(["Anton", "Olga"])
  })

  it("shows a person offline with the chats the saved member lists share", async () => {
    const store = await keptStore()
    await store.applyDelta(account, { people, members: new Map([["7", ["500", "23"]]]) })
    const service = peopleService(storedDeps(messenger, store, account, guard))

    const card = await service.show("Boris")

    expect(card.chats).toEqual([{ id: "7", title: "Book club", kind: "group", lastMessageAt: chats[0]?.lastMessageAt }])
  })
})
