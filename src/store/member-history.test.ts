import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import type { GroupMember } from "../domain/models.js"
import { type AccountKey, openStore, queryFilter, TRACKED_CHAT_COLUMNS } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "member-history-")), "messages.db")
const OWNER: AccountKey = { provider: "telegram", account: "1" }
const DAY = 86_400_000
const START = Date.parse("2026-09-01T10:00:00.000Z")

const member = (id: string, extra: Partial<GroupMember> = {}): GroupMember => ({
  id,
  name: `Member ${id}`,
  username: null,
  role: "member",
  ...extra,
})

const clocked = async () => {
  let at = START
  const store = await openStore({ path: fresh(), now: () => at })
  await store.chats.saveChats(OWNER, [
    { id: "7", title: "Club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 3 },
  ])
  return { store, nextDay: () => (at += DAY) }
}

describe("member history", () => {
  it("opens a stay on first sight, keeps it, and closes it only from a list read whole", async () => {
    const { store, nextDay } = await clocked()

    expect(
      await store.roster.saveRoster(OWNER, "7", {
        members: [member("21", { joinedAt: "2026-08-30T08:00:00.000Z", invitedBy: "99" }), member("22")],
        complete: true,
        participants: 2,
      }),
    ).toEqual({ joined: ["21", "22"], gone: [], changed: [] })
    nextDay()
    expect(
      await store.roster.saveRoster(OWNER, "7", { members: [member("21")], complete: false, participants: 2 }),
    ).toEqual({
      joined: [],
      gone: [],
      changed: [],
    })
    nextDay()
    expect(
      await store.roster.saveRoster(OWNER, "7", { members: [member("21")], complete: true, participants: 1 }),
    ).toEqual({
      joined: [],
      gone: ["22"],
      changed: [],
    })

    expect(await store.roster.memberStays(OWNER, "7")).toMatchObject([
      {
        id: "21",
        firstSeenAt: "2026-09-01T10:00:00.000Z",
        lastSeenAt: "2026-09-03T10:00:00.000Z",
        joinedAt: "2026-08-30T08:00:00.000Z",
        invitedBy: "99",
        goneAt: null,
      },
      { id: "22", goneAt: "2026-09-03T10:00:00.000Z" },
    ])
    expect((await store.roster.members(OWNER, "7")).map(({ id }) => id)).toEqual(["21"])
    expect(await store.roster.memberCounts(OWNER, "7")).toEqual([
      { day: "2026-09-01", participants: 2, listed: 2, complete: true },
      { day: "2026-09-02", participants: 2, listed: 1, complete: false },
      { day: "2026-09-03", participants: 1, listed: 1, complete: true },
    ])
    await store.close()
  })

  it("gives someone who comes back a new stay", async () => {
    const { store, nextDay } = await clocked()
    await store.roster.saveRoster(OWNER, "7", { members: [member("21")], complete: true, participants: 1 })
    nextDay()
    await store.roster.saveRoster(OWNER, "7", { members: [], complete: true, participants: 0 })
    nextDay()

    expect(
      await store.roster.saveRoster(OWNER, "7", { members: [member("21")], complete: true, participants: 1 }),
    ).toEqual({
      joined: ["21"],
      gone: [],
      changed: [],
    })
    expect((await store.roster.memberStays(OWNER, "7")).map(({ goneAt }) => goneAt)).toEqual([
      "2026-09-02T10:00:00.000Z",
      null,
    ])
    expect(await store.roster.memberStays(OWNER, "7", { since: "2026-09-02T12:00:00.000Z" })).toHaveLength(1)
    await store.close()
  })

  it("records a profile once, and again only when it changes", async () => {
    const { store, nextDay } = await clocked()
    await store.roster.saveRoster(OWNER, "7", { members: [member("21")], complete: true, participants: 1 })
    nextDay()
    await store.roster.saveRoster(OWNER, "7", { members: [member("21")], complete: true, participants: 1 })
    nextDay()

    const renamed = member("21", { name: "New name", isBot: true })
    expect(
      (await store.roster.saveRoster(OWNER, "7", { members: [renamed], complete: true, participants: 1 })).changed,
    ).toEqual(["21"])
    expect(await store.roster.profileRevisions(OWNER, "7")).toEqual([
      expect.objectContaining({ name: "Member 21", marks: {}, capturedAt: "2026-09-01T10:00:00.000Z" }),
      expect.objectContaining({ name: "New name", marks: { bot: true }, capturedAt: "2026-09-03T10:00:00.000Z" }),
    ])
    await store.close()
  })

  it("tracks a chat until told to stop, keeping when it started", async () => {
    const { store, nextDay } = await clocked()
    await store.roster.trackMembers(OWNER, "7", true)
    nextDay()
    await store.roster.trackMembers(OWNER, "7", true)
    await store.roster.saveRoster(OWNER, "7", { members: [member("21")], complete: true, participants: 1 })

    expect(await store.roster.trackedChats(OWNER)).toEqual([
      {
        chatId: "7",
        title: "Club",
        trackedAt: "2026-09-01T10:00:00.000Z",
        lastCount: { day: "2026-09-02", participants: 1, listed: 1, complete: true },
      },
    ])
    await store.roster.trackMembers(OWNER, "7", false)
    expect(await store.roster.trackedChats(OWNER)).toEqual([])
    expect(await store.roster.memberCounts(OWNER, "7")).toHaveLength(1)
    await store.close()
  })

  it("filters tracked chats in SQL and keeps each account's tracking separate", async () => {
    const { store } = await clocked()
    const other = { provider: "telegram", account: "2" }
    await store.chats.saveChats(OWNER, [
      { id: "8", title: "Project room", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
      { id: "9", title: "Club annex", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
    ])
    await store.chats.saveChats(other, [
      { id: "10", title: "Club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
    ])
    await store.roster.trackMembers(OWNER, "7", true)
    await store.roster.trackMembers(OWNER, "8", true)
    await store.roster.trackMembers(other, "10", true)
    const ids = async (text: string) =>
      (
        await store.roster.trackedChats(OWNER, {
          where: queryFilter(parseLucene(text, { defaultField: "none" }), TRACKED_CHAT_COLUMNS),
        })
      ).map((one) => one.chatId)
    expect(await ids("title:club")).toEqual(["7"])
    expect(await ids("chat_id:8")).toEqual(["8"])
    expect(await ids("title:club OR chat_id:8")).toEqual(["7", "8"])
    expect(await ids("title:club AND chat_id:8")).toEqual([])
    expect(await ids("NOT title:club")).toEqual(["8"])
    expect(await ids('chat_id:"7\' OR 1=1 --"')).toEqual([])
    await store.close()
  })

  it("is removed with the account", async () => {
    const { store } = await clocked()
    await store.roster.saveRoster(OWNER, "7", { members: [member("21")], complete: true, participants: 1 })

    await store.accounts.purge(OWNER)

    expect(await store.roster.memberStays(OWNER, "7")).toEqual([])
    expect(await store.roster.memberCounts(OWNER, "7")).toEqual([])
    await store.close()
  })
})
