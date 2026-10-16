import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat } from "../domain/models.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "members-")), "messages.db")
const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "max", account: "2" }

const chat = (id: string, lastMessageAt: string | null): Chat => ({
  id,
  title: `Chat ${id}`,
  kind: "group",
  unreadCount: 0,
  lastMessageAt,
  participantsCount: null,
})

describe("chat members", () => {
  it("includes memberless dialogs named by the person id, with account and provider isolation", async () => {
    const store = await openStore({ path: fresh() })
    const tg = { provider: "telegram", account: "1" }
    const otherTg = { provider: "telegram", account: "2" }
    const dialog = { ...chat("7", "2026-09-10T00:00:00.000Z"), kind: "dialog" as const }
    await store.chats.saveChats(tg, [dialog, chat("-1", "2026-09-20T00:00:00.000Z")])
    await store.roster.saveMembers(tg, "-1", ["7", "8"])
    await store.chats.saveChats(otherTg, [{ ...dialog, title: "Other account" }])
    await store.chats.saveChats(OWNER, [chat("7", null)])

    expect((await store.chats.chatsWith(tg, "7")).map(({ id }) => id)).toEqual(["-1", "7"])
    expect((await store.chats.chatsWith(otherTg, "7")).map(({ title }) => title)).toEqual(["Other account"])
    expect(await store.chats.chatsWith(OWNER, "7")).toEqual([])
    expect(await store.chats.chatsWith({ provider: "telegram", account: "3" }, "7")).toEqual([])
    expect(await store.chats.chatsWith(tg, "8")).toHaveLength(1)
    expect(await store.roster.members(tg, "7")).toEqual([])

    await store.roster.saveMembers(tg, "7", ["7", "1"])
    expect((await store.chats.chatsWith(tg, "7")).map(({ id }) => id)).toEqual(["-1", "7"])
    await store.roster.saveMembers(tg, "7", ["8", "1"])
    expect((await store.chats.chatsWith(tg, "7")).map(({ id }) => id)).toEqual(["-1"])
    expect((await store.chats.chatsWith(tg, "8")).map(({ id }) => id)).toEqual(["-1", "7"])

    await store.roster.saveMembers(tg, "7", [])
    await store.chats.markChatsLeft(tg, ["-1"])
    expect((await store.chats.chatsWith(tg, "7")).map(({ id }) => id)).toEqual(["-1"])
    await store.close()
  })

  it("**a new list replaces the old one whole**, and members come back by name", async () => {
    const store = await openStore({ path: fresh() })
    await store.people.savePeople(OWNER, [
      { id: "7", name: "Vera" },
      { id: "8", name: "Anna", username: "anna" },
      { id: "9", name: null },
    ])
    await store.roster.saveMembers(OWNER, "-100", ["7", "8", "9"])
    await store.roster.saveMembers(OWNER, "-100", ["8", "7", "7"])

    expect(await store.roster.members(OWNER, "-100")).toEqual([
      { id: "8", name: "Anna", username: "anna" },
      { id: "7", name: "Vera", username: null },
    ])
    expect(await store.roster.members(OWNER, "-404")).toEqual([])
    await store.close()
  })

  it("finds the chats a person is in, newest first, for this account only", async () => {
    const store = await openStore({ path: fresh() })
    await store.chats.saveChats(OWNER, [chat("-1", "2026-09-01T00:00:00.000Z"), chat("-2", "2026-09-20T00:00:00.000Z")])
    await store.roster.saveMembers(OWNER, "-1", ["7"])
    await store.roster.saveMembers(OWNER, "-2", ["7", "8"])
    await store.roster.saveMembers(OTHER, "-3", ["7"])

    expect((await store.chats.chatsWith(OWNER, "7")).map(({ id }) => id)).toEqual(["-2", "-1"])
    expect((await store.chats.chatsWith(OTHER, "7")).map(({ id }) => id)).toEqual(["-3"])
    expect(await store.roster.members(OTHER, "-2")).toEqual([])
    expect(await store.chats.chatsWith({ provider: "max", account: "3" }, "7")).toEqual([])
    await store.close()
  })
})
