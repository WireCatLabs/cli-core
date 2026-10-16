import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { type AccountKey, openStore } from "../store/store.js"
import { storedDeps } from "./deps.js"
import { peopleService } from "./people.js"

const OWNER: AccountKey = { provider: "telegram", account: "1" }
const DAY = 86_400_000
const START = Date.parse("2026-09-01T10:00:00.000Z")

const message = (id: string, senderId: string, senderName: string, timestamp: string): Message => ({
  id,
  chatId: "-1",
  senderId,
  senderName,
  timestamp,
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const clocked = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "aliases-")), "messages.db")
  let at = START
  const store = await openStore({ path, now: () => at })
  await store.chats.saveChats(OWNER, [
    { id: "-1", title: "Club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  const people = peopleService(
    storedDeps({ provider: "telegram", app: { command: "tg" } } as Messenger, store, OWNER, {} as SendGuard),
  )
  return { path, store, people, nextDay: () => (at += DAY) }
}

describe("past names", () => {
  it("keeps a renamed person's earlier name and username, with a link, and does not repeat the current one", async () => {
    const { store, people, nextDay } = await clocked()
    await store.people.savePeople(OWNER, [{ id: "10", name: "Ann Old", username: "ann_old" }])
    nextDay()
    await store.people.savePeople(OWNER, [{ id: "10", name: "Ann New", username: "ann_new" }])

    expect((await people.profile("10")).aliases).toEqual([
      {
        name: "Ann Old",
        username: "ann_old",
        link: "https://t.me/ann_old",
        firstSeenAt: "2026-09-01T10:00:00.000Z",
        lastSeenAt: "2026-09-01T10:00:00.000Z",
        source: "profile",
      },
    ])
    await store.close()
  })

  it("reads a sender's earlier name off stored messages, and never merges two people who shared one", async () => {
    const { path, store } = await clocked()
    await store.messages.saveMessages(
      OWNER,
      "-1",
      [
        message("1", "10", "Ann", "2026-08-01T00:00:00.000Z"),
        message("2", "10", "Ann", "2026-08-02T00:00:00.000Z"),
        message("3", "20", "Bob", "2026-08-03T00:00:00.000Z"),
      ],
      { via: "fetch" },
    )
    await store.close()
    const db = new DatabaseSync(path)
    db.exec("UPDATE messages SET sender_name = 'Bea' WHERE external_id = '2'")
    db.close()
    const reopened = await openStore({ path })
    const read = peopleService(
      storedDeps({ provider: "telegram", app: { command: "tg" } } as Messenger, reopened, OWNER, {} as SendGuard),
    )

    expect((await read.profile("10")).aliases).toEqual([
      {
        name: "Bea",
        firstSeenAt: "2026-08-02T00:00:00.000Z",
        lastSeenAt: "2026-08-02T00:00:00.000Z",
        source: "messages",
      },
    ])
    expect((await read.profile("20")).aliases).toEqual([])
    await reopened.close()
  })

  it("does not report a member as changed when a list read only adds what a message did not say", async () => {
    const { store, nextDay } = await clocked()
    await store.messages.saveMessages(OWNER, "-1", [message("1", "10", "Ann", "2026-08-01T00:00:00.000Z")], {
      via: "fetch",
    })
    nextDay()
    await store.messages.saveMessages(OWNER, "-1", [message("2", "10", "Ann B", "2026-08-02T00:00:00.000Z")], {
      via: "fetch",
    })
    nextDay()
    const member = { id: "10", name: "Ann B", username: null, role: "member" as const, hasPhoto: true }

    expect(
      await store.roster.saveRoster(OWNER, "-1", { members: [member], complete: false, participants: null }),
    ).toEqual({
      joined: ["10"],
      gone: [],
      changed: [],
    })
    expect((await store.roster.profileRevisions(OWNER, "-1")).map(({ name, marks }) => ({ name, marks }))).toEqual([
      { name: "Ann", marks: {} },
      { name: "Ann B", marks: { photo: true } },
    ])
    await store.close()
  })
})
