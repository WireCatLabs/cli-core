import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { chatIdIn, storedChatId } from "../services/message-resolution.js"
import { openCache } from "./open.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "chat-revisions-")), "wirecat.db")
const OWNER: AccountKey = { provider: "whatsapp", account: "1@lid" }
const OTHER: AccountKey = { provider: "whatsapp", account: "2@lid" }
const PHONE = "34600000001@s.whatsapp.net"
const LID = "777@lid"

const chat = (id: string, title: string | null, extra: Partial<Chat> = {}): Chat => ({
  id,
  title,
  kind: "dialog",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
  ...extra,
})

const message = (id: string, chatId: string): Message => ({
  id,
  chatId,
  senderId: "500",
  senderName: "Me",
  timestamp: "2026-10-19T10:00:00.000Z",
  editedAt: null,
  text: "hello",
  outgoing: true,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const sql = async (path: string, statement: string, ...parameters: (string | number)[]) => {
  const database = await openCache(path)
  try {
    return database
      .prepare(statement)
      .all(...parameters)
      .map((row) => ({ ...row }))
  } finally {
    database.close()
  }
}

const revisions = (path: string) =>
  sql(
    path,
    `SELECT a.external_id AS account, r.field, r.old_value AS old, r.new_value AS new, r.source
      FROM chat_revisions r JOIN accounts a ON a.id = r.account_id ORDER BY r.id`,
  )

const opened = async () => {
  const path = fresh()
  return { path, store: await openStore({ path }) }
}

describe("chat_revisions", () => {
  it("**a re-key records the old id**, and a read by it finds the chat it became", async () => {
    const { path, store } = await opened()
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana")])
    await store.chats.rekeyChat(OWNER, PHONE, LID)

    expect(await revisions(path)).toEqual([
      { account: OWNER.account, field: "external_id", old: PHONE, new: LID, source: "rekey" },
    ])
    expect(await store.chats.renamedChatId(OWNER, PHONE)).toBe(LID)
    expect(await storedChatId({}, PHONE, store, OWNER)).toBe(LID)
    expect(await chatIdIn({}, PHONE, store.forAccount(OWNER))).toBe(LID)
    await store.close()
  })

  it("**follows a chain of re-keys** to the chat's current id, and a chat stored under the old id again wins", async () => {
    const { store } = await opened()
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana")])
    await store.chats.rekeyChat(OWNER, PHONE, LID)
    await store.chats.rekeyChat(OWNER, LID, "888@lid")
    expect(await store.chats.renamedChatId(OWNER, PHONE)).toBe("888@lid")

    await store.chats.saveChats(OWNER, [chat(PHONE, "Someone new")])
    expect(await store.chats.renamedChatId(OWNER, PHONE)).toBeUndefined()
    await store.close()
  })

  it("**a merge records the stricter privacy the kept chat took**, and keeps the absorbed chat's history", async () => {
    const { path, store } = await opened()
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana"), chat(LID, "Ana L")])
    await store.chats.rekeyChat(OWNER, LID, "999@lid")
    await sql(path, "UPDATE chats SET searchable = 0 WHERE external_id = ?", "999@lid")
    await store.chats.rekeyChat(OWNER, PHONE, "999@lid")

    expect((await revisions(path)).map(({ field, old, new: next, source }) => [field, old, next, source])).toEqual([
      ["external_id", LID, "999@lid", "rekey"],
      ["searchable", "1", "0", null],
      ["title", "Ana", "Ana L", "merge"],
      ["searchable", "1", "0", "merge"],
      ["external_id", PHONE, "999@lid", "merge"],
    ])
    const [kept] = await sql(path, "SELECT id FROM chats WHERE external_id = '999@lid'")
    expect(await sql(path, "SELECT DISTINCT chat_id AS chat FROM chat_revisions")).toEqual([{ chat: kept?.id }])
    expect(await store.chats.renamedChatId(OWNER, LID)).toBe("999@lid")
    expect(await store.chats.renamedChatId(OWNER, PHONE)).toBe("999@lid")
    await store.close()
  })

  it("**records the old id once** when only the new id is stored, however often the re-key is replayed", async () => {
    const { path, store } = await opened()
    await store.chats.saveChats(OWNER, [chat(LID, "Ana")])
    await store.chats.rekeyChat(OWNER, PHONE, LID)
    await store.chats.rekeyChat(OWNER, PHONE, LID)

    expect(await revisions(path)).toEqual([
      { account: OWNER.account, field: "external_id", old: PHONE, new: LID, source: "rekey" },
    ])
    expect(await store.chats.renamedChatId(OWNER, PHONE)).toBe(LID)
    await store.close()
  })

  it("**records a title change with both values**, and nothing for a save that changes nothing", async () => {
    const { path, store } = await opened()
    await store.chats.saveChats(OWNER, [chat(LID, "Ana")])
    await store.chats.saveChats(OWNER, [chat(LID, "Ana")])
    await store.sync.applyDelta(OWNER, { chats: [chat(LID, "Ana")] })
    expect(await revisions(path)).toEqual([])

    await store.chats.saveChats(OWNER, [chat(LID, "Ana Lopez")])
    await store.sync.applyDelta(OWNER, { chats: [chat(LID, "Ana L.")] })
    await store.chats.saveChatMetadata(OWNER, { chatId: LID, title: "Ana", username: null, description: null })

    expect((await revisions(path)).map(({ field, old, new: next, source }) => [field, old, next, source])).toEqual([
      ["title", "Ana", "Ana Lopez", "chats"],
      ["title", "Ana Lopez", "Ana L.", "delta"],
      ["title", "Ana L.", "Ana", "details"],
    ])
    expect(await sql(path, "SELECT count(*) AS n FROM chat_revision_source")).toEqual([{ n: 0 }])
    await store.close()
  })

  it("**records leaving and rejoining**, and a membership state the messenger reports", async () => {
    const { path, store } = await opened()
    await store.chats.saveChats(OWNER, [chat("g1", "Team", { kind: "group" }), chat("g2", "Club", { kind: "group" })])
    await store.chats.markChatsLeft(OWNER, ["g2"])
    await store.chats.markChatsLeft(OWNER, ["g2"])
    await store.chats.rejoinChats(OWNER, ["g1"])
    await store.chats.saveChats(OWNER, [chat("g2", "Club", { kind: "group", membershipState: "archived" })])

    expect((await revisions(path)).map(({ field, old, new: next, source }) => [field, old, next, source])).toEqual([
      ["membership_state", null, "left", "left"],
      ["membership_state", "left", null, "rejoin"],
      ["membership_state", null, "archived", "chats"],
    ])
    await store.close()
  })

  it("**records scope and search visibility**, from the store's writes and from SQL by hand", async () => {
    const { path, store } = await opened()
    await store.chats.saveChats(OWNER, [chat(LID, "Ana"), chat(PHONE, "Ana")])
    await store.chats.saveChats(OWNER, [chat(LID, "Ana", { scope: "work" })])
    await sql(path, "UPDATE chats SET searchable = 0 WHERE external_id = ?", PHONE)
    await store.messages.saveMessages(OWNER, LID, [message("1", LID)], { via: "send", typedChatId: PHONE })

    expect((await revisions(path)).map(({ field, old, new: next, source }) => [field, old, next, source])).toEqual([
      ["scope", null, "work", "chats"],
      ["searchable", "1", "0", null],
      ["scope", "work", "personal", "send"],
      ["searchable", "1", "0", "send"],
    ])
    await store.close()
  })

  it("**keeps each account's history apart**: the same old id in another account finds nothing", async () => {
    const { path, store } = await opened()
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana")])
    await store.chats.saveChats(OTHER, [chat(PHONE, "Ana")])
    await store.chats.rekeyChat(OWNER, PHONE, LID)
    await store.chats.saveChats(OTHER, [chat(LID, "Someone")])
    await sql(
      path,
      "DELETE FROM chats WHERE external_id = ? AND account_id = (SELECT id FROM accounts WHERE external_id = ?)",
      PHONE,
      OTHER.account,
    )

    expect(await store.chats.renamedChatId(OWNER, PHONE)).toBe(LID)
    expect(await store.chats.renamedChatId(OTHER, PHONE)).toBeUndefined()
    expect((await revisions(path)).map(({ account }) => account)).toEqual([OWNER.account])
    await store.close()
  })

  it("**a revision that cannot be written undoes the change**: both are one transaction", async () => {
    const { path, store } = await opened()
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana")])
    await sql(
      path,
      "CREATE TRIGGER refuse_revisions BEFORE INSERT ON chat_revisions BEGIN SELECT RAISE(ABORT, 'refused'); END",
    )

    await expect(store.chats.saveChats(OWNER, [chat(PHONE, "Ana Lopez")])).rejects.toThrow()
    await expect(store.chats.rekeyChat(OWNER, PHONE, LID)).rejects.toThrow("refused")
    expect(await sql(path, "SELECT external_id AS id, title FROM chats")).toEqual([{ id: PHONE, title: "Ana" }])
    expect(await sql(path, "SELECT count(*) AS n FROM chat_revision_source")).toEqual([{ n: 0 }])
    await store.close()
  })

  it("**a purged chat's history goes with it**", async () => {
    const { path, store } = await opened()
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana", { kind: "group" })])
    await store.chats.rekeyChat(OWNER, PHONE, LID)
    await store.chats.markChatsLeft(OWNER, [])
    await store.chats.leftChats(OWNER, { clear: true })

    expect(await revisions(path)).toEqual([])
    expect(await store.chats.renamedChatId(OWNER, PHONE)).toBeUndefined()
    await store.close()
  })
})
