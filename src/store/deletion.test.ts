import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { openCache } from "./open.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "deletion-")), "messages.db")
const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "max", account: "2" }

const message = (id: string, text: string): Message => ({
  id,
  chatId: "-1",
  senderId: "7",
  senderName: "Ana",
  timestamp: "2026-09-30T10:00:00.000Z",
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const raw = async (path: string, sql: string) => {
  const database = await openCache(path)
  try {
    return database
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }))
  } finally {
    database.close()
  }
}

describe("deleting a message (NEED-393 A)", () => {
  it("**leaves no text behind** — not in the row, the search copy, the edit history or the transcript", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.messages.saveMessages(OWNER, "-1", [message("42", "first secret")], { via: "history" })
    await store.messages.saveMessages(OWNER, "-1", [message("42", "edited secret")], { via: "update" })
    await store.messages.keepTranscript(OWNER, "-1", "42", "spoken secret", "telegram")

    expect(await store.messages.markDeleted(OWNER, ["42"], { chatId: "-1" })).toBe(1)

    expect(await raw(path, "SELECT text, normalized_text, deleted_at IS NOT NULL AS gone FROM messages")).toEqual([
      { text: "", normalized_text: null, gone: 1 },
    ])
    expect(await raw(path, "SELECT count(*) AS n FROM message_revisions")).toEqual([{ n: 0 }])
    expect(await store.messages.transcript(OWNER, "-1", "42")).toBeUndefined()
    expect((await store.messages.search("secret", { limit: 5 })).items).toEqual([])
    expect(await store.messages.message(OWNER, "42", { chatId: "-1" })).toBeUndefined()
    expect(await store.messages.countMessages(OWNER, "-1")).toBe(0)
    await store.close()
  })

  it("**a copy fetched before the deletion does not bring it back**; one fetched after it does", async () => {
    let clock = 1_000
    const path = fresh()
    const store = await openStore({ path, now: () => clock })
    await store.messages.saveMessages(OWNER, "-1", [message("42", "secret")], { via: "history" })
    clock = 2_000
    await store.messages.markDeleted(OWNER, ["42"], { chatId: "-1" })

    await store.messages.saveMessages(OWNER, "-1", [message("42", "secret")], { via: "history" })
    await store.messages.saveMessages(OWNER, "-1", [message("42", "secret")], { via: "history", seenAt: 1_500 })
    expect(await raw(path, "SELECT text, deleted_at IS NOT NULL AS gone FROM messages")).toEqual([
      { text: "", gone: 1 },
    ])
    expect(await raw(path, "SELECT count(*) AS n FROM message_revisions")).toEqual([{ n: 0 }])

    await store.messages.saveMessages(OWNER, "-1", [message("42", "still there")], { via: "history", seenAt: 3_000 })
    expect((await store.messages.message(OWNER, "42", { chatId: "-1" }))?.text).toBe("still there")
    expect(await raw(path, "SELECT count(*) AS n FROM message_revisions")).toEqual([{ n: 0 }])
    expect((await store.messages.search("still", { limit: 5 })).items.map(({ id }) => id)).toEqual(["42"])
    await store.close()
  })
})

describe("purging an account", () => {
  it("**removes everything it held and leaves the other account whole**", async () => {
    const path = fresh()
    const store = await openStore({ path })
    for (const key of [OWNER, OTHER]) {
      await store.chats.saveChats(key, [
        { id: "-1", title: "Valencia", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
      ])
      await store.messages.saveMessages(key, "-1", [message("42", "hola"), message("43", "adiós")], { via: "history" })
      await store.messages.saveMessages(key, "-1", [message("42", "hola, editado")], { via: "update" })
      await store.roster.saveMembers(key, "-1", ["7", "8"])
      await store.sync.setSyncState(key, "login.marker", "5")
      await store.sync.claim(key, "-1", "newest", "a", 60_000)
      await store.messages.keepTranscript(key, "-1", "43", "dicho", "telegram")
      await store.sync.markRange(key, "-1", 42, 43)
    }

    await store.accounts.purge(OWNER)

    expect((await store.chats.chats(OWNER, {})).items).toEqual([])
    expect(await store.roster.members(OWNER, "-1")).toEqual([])
    expect(await store.sync.syncState(OWNER, "login.marker")).toBeUndefined()
    expect(await store.messages.transcript(OWNER, "-1", "43")).toBeUndefined()
    expect((await store.people.people("max", { account: "1" })).all()).toEqual([])
    expect(await store.sync.claim(OWNER, "-1", "newest", "b", 60_000)).toBe(true)

    expect((await store.messages.messages(OTHER, "-1", { limit: 5 })).items.map(({ id }) => id)).toEqual(["42", "43"])
    expect(await store.roster.members(OTHER, "-1")).toHaveLength(2)
    expect(await store.messages.transcript(OTHER, "-1", "43")).toMatchObject({ text: "dicho" })
    expect((await store.messages.search("hola", { limit: 5 })).items).toHaveLength(1)
    expect(await raw(path, "INSERT INTO messages_fts (messages_fts) VALUES ('integrity-check')")).toEqual([])
    await store.close()
  })
})
