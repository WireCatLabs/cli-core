import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { syncMail } from "../mail/sync.js"
import { type FakeMail, fakeMailSource } from "../mail/testing/fake.js"
import { FETCHING, fetchInto } from "../services/archive.js"
import { forgetCoverageSince } from "./refill.js"
import { historyStartKey, type MessageStore, openSqlite, openStore } from "./store.js"

const account = { provider: "test", account: "500" }
const START = Date.parse("2026-11-01T00:00:00.000Z")
const at = (n: number) => START + n * 60_000

const messageAt = (id: number): Message => ({
  id: String(id),
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: new Date(at(id)).toISOString(),
  editedAt: null,
  text: `chapter ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const newStore = () => join(mkdtempSync(join(tmpdir(), "refill-")), "m.db")

const withDatabase = async <T>(
  path: string,
  work: (database: Awaited<ReturnType<typeof openSqlite>>["database"]) => T,
) => {
  const { database } = await openSqlite(path)
  try {
    return work(database)
  } finally {
    database.close()
  }
}

const sync = (store: MessageStore, history: Message[], orderBy: "id" | "time") => {
  const keyed = (one: Message) => (orderBy === "time" ? at(Number(one.id)) : Number(one.id))
  return fetchInto({
    history: async ({ limit, before }) => {
      const older = history.filter(
        (one) => before === undefined || keyed(one) < Number(orderBy === "time" ? Date.parse(before) : before),
      )
      const items = older.slice(-limit).reverse()
      await store.messages.saveMessages(account, "7", items, { via: "history" })
      return { items, hasMore: older.length > items.length }
    },
    store,
    account,
    fetching: { ...FETCHING, orderBy },
    limit: 1000,
    pageSize: 100,
    pauseMs: 0,
    note: () => {},
    stop: new AbortController().signal,
    onPage: () => {},
  })
}

const held = async (path: string) => {
  const store = await openStore({ path })
  try {
    return {
      count: (await store.chats.chatStats(account, "7"))[0]?.messages,
      ranges: await store.sync.ranges(account, "7"),
    }
  } finally {
    await store.close()
  }
}

describe.each(["id", "time"] as const)("forgetting what a chat held after a time, keyed by %s", (orderBy) => {
  it("**lets one ordinary sync fetch again a hole that sync would otherwise jump over**", async () => {
    const path = newStore()
    const history = Array.from({ length: 300 }, (_, i) => messageAt(i + 1))
    const store = await openStore({ path })
    await store.chats.saveChats(account, [
      { id: "7", title: "Book club", kind: "group", unreadCount: 0, lastMessageAt: null },
    ])
    await sync(store, history, orderBy)
    await store.close()
    await withDatabase(path, (database) =>
      database.prepare("DELETE FROM messages WHERE CAST(external_id AS INTEGER) BETWEEN 151 AND 200").run(),
    )

    const again = await openStore({ path })
    await sync(again, history, orderBy)
    await again.close()
    expect((await held(path)).count).toBe(250)

    const forgotten = await withDatabase(path, (database) => forgetCoverageSince(database, at(140) + 30_000))
    const back = await openStore({ path })
    await sync(back, history, orderBy)
    await back.close()

    expect(forgotten.chats).toEqual([{ provider: "test", account: "500", chats: 1 }])
    const after = await held(path)
    expect(after.count).toBe(300)
    expect(after.ranges).toHaveLength(1)
  })
})

describe("forgetting what a chat held", () => {
  it("drops the start mark when no stretch reaching the start is left, and every stretch without a cutoff", async () => {
    const path = newStore()
    const store = await openStore({ path })
    await store.chats.saveChats(account, [
      { id: "7", title: "Book club", kind: "group", unreadCount: 0, lastMessageAt: null },
    ])
    await sync(store, [1, 2, 3].map(messageAt), "id")
    expect(await store.sync.syncState(account, historyStartKey("7"))).toBeDefined()
    await store.close()

    const forgotten = await withDatabase(path, (database) => forgetCoverageSince(database, null))

    expect(forgotten.since).toBeNull()
    const reopened = await openStore({ path })
    expect(await reopened.sync.ranges(account, "7")).toEqual([])
    expect(await reopened.sync.syncState(account, historyStartKey("7"))).toBeUndefined()
    await reopened.close()
  })
})

describe.each([false, true])("forgetting what a mail folder listed (quick server: %s)", (quick) => {
  it("**lets the next ordinary sync store again the mail lost after the cutoff**", async () => {
    const path = newStore()
    const messages: FakeMail[] = Array.from({ length: 40 }, (_, i) => ({
      uid: String(i + 1),
      messageId: `m${i + 1}@example.test`,
      threadId: `t${i + 1}`,
      receivedAt: new Date(at(i + 1)).toISOString(),
      subject: `letter ${i + 1}`,
      from: ["Olga", "olga@example.test"],
      to: [[null, "owner@example.test"]],
      text: `body ${i + 1}`,
    }))
    const source = fakeMailSource({ messages, ...(quick ? { quick: true } : {}) })
    const options = { account: { address: "owner@example.test" }, since: new Date(START - 86_400_000), resumeFrom: 1 }
    const store = await openStore({ path })
    await syncMail(source, store, options)
    await store.close()
    const lost = await withDatabase(path, (database) => {
      database.exec("PRAGMA foreign_keys=OFF")
      const ids = `SELECT id FROM emails WHERE CAST(substr(subject, 8) AS INTEGER) BETWEEN 21 AND 30`
      database.exec(`DELETE FROM email_locations WHERE email_id IN (${ids})`)
      database.exec(`DELETE FROM email_mailboxes WHERE email_id IN (${ids})`)
      return database.prepare(`DELETE FROM emails WHERE id IN (${ids})`).run().changes
    })
    expect(lost).toBe(10)
    const count = async () => {
      const opened = await openStore({ path })
      try {
        const { id } = await opened.accounts.storedAccount({ provider: "email", account: "owner@example.test" })
        return (await opened.mail.emails({ accountId: id, limit: 1000 })).length
      } finally {
        await opened.close()
      }
    }
    const before = await openStore({ path })
    await syncMail(source, before, options)
    await before.close()
    expect(await count()).toBe(30)

    const forgotten = await withDatabase(path, (database) => forgetCoverageSince(database, at(20) + 30_000))
    const after = await openStore({ path })
    await syncMail(source, after, options)
    await after.close()

    expect(forgotten.mail).toEqual([{ account: "owner@example.test", folders: expect.any(Number) }])
    expect(await count()).toBe(40)
  })
})
