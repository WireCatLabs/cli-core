import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { openCache } from "./open.js"
import { type AccountKey, historyStartKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "rekey-")), "wirecat.db")
const OWNER: AccountKey = { provider: "whatsapp", account: "1@lid" }
const OTHER: AccountKey = { provider: "whatsapp", account: "2@lid" }
const PHONE = "34600000001@s.whatsapp.net"
const LID = "777@lid"

const chat = (id: string, title: string | null, kind: Chat["kind"] = "dialog"): Chat => ({
  id,
  title,
  kind,
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
})

const message = (id: string, chatId: string, text: string, timestamp = "2026-10-18T10:00:00.000Z"): Message => ({
  id,
  chatId,
  senderId: "7",
  senderName: "Ana",
  timestamp,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const raw = async (path: string, sql: string, ...parameters: string[]) => {
  const database = await openCache(path)
  try {
    return database
      .prepare(sql)
      .all(...parameters)
      .map((row) => ({ ...row }))
  } finally {
    database.close()
  }
}

const texts = async (store: Awaited<ReturnType<typeof openStore>>, chatId: string) =>
  (await store.messages.messages(OWNER, chatId, { limit: 50 })).items.map((one) => one.text).sort()

type Settings = { searchable: number; scope: string | null }

const settle = async (path: string, key: AccountKey, chatId: string, { searchable, scope }: Settings) => {
  const database = await openCache(path)
  try {
    database
      .prepare(
        "UPDATE chats SET searchable = ?, scope = ? WHERE external_id = ? AND account_id = (SELECT id FROM accounts WHERE external_id = ?)",
      )
      .run(searchable, scope, chatId, key.account)
  } finally {
    database.close()
  }
}

const settings = (path: string, key: AccountKey) =>
  raw(
    path,
    "SELECT c.external_id AS id, c.searchable, c.scope FROM chats c JOIN accounts a ON a.id = c.account_id WHERE a.external_id = ? ORDER BY c.external_id",
    key.account,
  )

const accountScope = async (path: string, key: AccountKey, scope: string) => {
  const database = await openCache(path)
  try {
    database.prepare("UPDATE accounts SET scope = ? WHERE external_id = ?").run(scope, key.account)
  } finally {
    database.close()
  }
}

describe("re-keying a stored chat", () => {
  it("**renames a chat stored only under the old id**, with its messages, tags, cursors and task locators", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana")])
    await store.messages.saveMessages(OWNER, PHONE, [message("A1", PHONE, "hello from the phone form")], {
      via: "history",
    })
    await store.tags.addTags(OWNER, { type: "chat", chatId: PHONE }, ["family"])
    await store.sync.setSyncState(OWNER, historyStartKey(PHONE), "A1")
    const database = await openCache(path)
    database
      .prepare(
        "INSERT INTO projects (key, name, type, scope, created_at, updated_at) VALUES ('T', 'T', 'work', 'work', 0, 0)",
      )
      .run()
    database
      .prepare(
        "INSERT INTO tasks (project_id, number, key, title, type, status, author_type, author_id, source, source_locator, source_group, created_at, updated_at) VALUES (1, 1, 'T-1', 'reply', 'request', 'open', 'person', 1, 'rule', ?, ?, 0, 0)",
      )
      .run(`msg:whatsapp/1%40lid/${encodeURIComponent(PHONE)}/A1`, PHONE)
    database
      .prepare(
        "INSERT INTO links (from_type, from_id, kind, source, target_text, target_folded, created_at, updated_at) VALUES ('task', 1, 'evidence', 'owner', ?, ?, 0, 0)",
      )
      .run(
        `msg:whatsapp/1%40lid/${encodeURIComponent(PHONE)}/B9`,
        `msg:whatsapp/1%40lid/${encodeURIComponent(PHONE)}/b9`,
      )
    database.close()

    expect(await store.chats.rekeyChat(OWNER, PHONE, LID)).toEqual({ outcome: "renamed", messages: 0, duplicates: 0 })

    expect((await store.chats.chats(OWNER, {})).items.map((one) => one.id)).toEqual([LID])
    expect(await texts(store, LID)).toEqual(["hello from the phone form"])
    expect((await store.tags.tags(OWNER)).map((tag) => [tag.tag, tag.chatId])).toEqual([["family", LID]])
    expect(await store.sync.syncState(OWNER, historyStartKey(LID))).toMatchObject({ value: "A1" })
    expect(await store.sync.syncState(OWNER, historyStartKey(PHONE))).toBeUndefined()
    expect(await raw(path, "SELECT source_locator, source_group FROM tasks")).toEqual([
      { source_locator: "msg:whatsapp/1%40lid/777%40lid/A1", source_group: LID },
    ])
    expect(await raw(path, "SELECT target_text, target_folded FROM links")).toEqual([
      { target_text: "msg:whatsapp/1%40lid/777%40lid/B9", target_folded: "msg:whatsapp/1%40lid/777%40lid/b9" },
    ])
    expect((await store.messages.search("phone", { limit: 5, account: OWNER })).items.map((hit) => hit.chatId)).toEqual(
      [LID],
    )
    await store.close()
  })

  it("**merges a chat that split in two** into the old row, keeping one copy of a message held twice", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.chats.saveChats(OWNER, [chat(PHONE, null), chat(LID, "Ana García")])
    await store.messages.saveMessages(
      OWNER,
      PHONE,
      [message("A1", PHONE, "older under the phone"), message("A2", PHONE, "the message held twice")],
      { via: "history" },
    )
    await store.messages.saveMessages(
      OWNER,
      LID,
      [
        message("A2", LID, "the message held twice"),
        message("A3", LID, "newer under the lid", "2026-10-18T11:00:00.000Z"),
      ],
      { via: "update" },
    )
    await store.tags.addTags(OWNER, { type: "chat", chatId: PHONE }, ["family"])
    await store.tags.addTags(OWNER, { type: "chat", chatId: LID }, ["family", "spain"])
    await store.tags.addTags(OWNER, { type: "message", chatId: LID, messageId: "A3" }, ["todo"])
    await store.tags.addTags(OWNER, { type: "message", chatId: LID, messageId: "A2" }, ["kept"])
    await store.messages.saveVote(OWNER, PHONE, "A1", {
      person: { id: "7", name: "Ana", username: null },
      answers: ["1"],
      votedAt: "2026-10-18T10:00:00.000Z",
    })
    await store.messages.saveVote(OWNER, LID, "A1", {
      person: { id: "7", name: "Ana", username: null },
      answers: ["2"],
      votedAt: "2026-10-18T12:00:00.000Z",
    })
    const reaction = (id: string, emoji: string, reactedAt: string) => ({
      person: { id, name: null, username: null },
      own: false,
      reaction: emoji,
      reactedAt,
    })
    await store.messages.saveReaction(OWNER, PHONE, "A1", reaction("7", "👍", "2026-10-18T10:00:00.000Z"))
    await store.messages.saveReaction(OWNER, PHONE, "A1", reaction("8", "😮", "2026-10-18T10:00:00.000Z"))
    await store.messages.saveReaction(OWNER, LID, "A1", reaction("7", "❤️", "2026-10-18T12:00:00.000Z"))
    const [{ id: kept }] = (await raw(path, "SELECT id FROM chats WHERE external_id = ?", PHONE)) as [{ id: number }]

    expect(await store.chats.rekeyChat(OWNER, PHONE, LID)).toEqual({ outcome: "merged", messages: 1, duplicates: 1 })

    expect(await raw(path, "SELECT id, external_id, title, message_count FROM chats")).toEqual([
      { id: kept, external_id: LID, title: "Ana García", message_count: 3 },
    ])
    expect(await texts(store, LID)).toEqual(["newer under the lid", "older under the phone", "the message held twice"])
    expect(await store.messages.countMessages(OWNER, LID)).toBe(3)
    const tags = (await store.tags.tags(OWNER)).map((tag) => [tag.tag, tag.type, tag.chatId]).sort()
    expect(tags).toEqual([
      ["family", "chat", LID],
      ["kept", "message", LID],
      ["spain", "chat", LID],
      ["todo", "message", LID],
    ])
    expect((await store.messages.pollVotes(OWNER, LID, "A1")).map((vote) => vote.answers)).toEqual([["2"]])
    expect((await store.messages.message(OWNER, "A1", { chatId: LID }))?.reactions?.counts).toEqual([
      { reaction: "😮", count: 1 },
      { reaction: "❤️", count: 1 },
    ])
    expect((await store.messages.search("lid", { limit: 5, account: OWNER })).items.map((hit) => hit.chatId)).toEqual([
      LID,
    ])
    expect(await raw(path, "SELECT count(*) AS n FROM messages")).toEqual([{ n: 3 }])
    await store.close()
  })

  it("carries the owner's stars into the merged chat, a twin's star filling only where the kept copy has none", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.messages.saveMessages(
      OWNER,
      PHONE,
      [message("A1", PHONE, "starred under the phone"), message("A2", PHONE, "held twice")],
      { via: "history" },
    )
    await store.messages.saveMessages(
      OWNER,
      LID,
      [message("A2", LID, "held twice"), message("A3", LID, "starred under the lid")],
      {
        via: "history",
        stars: [
          { messageId: "A2", starred: true },
          { messageId: "A3", starred: true },
        ],
      },
    )
    await store.messages.saveStar(OWNER, PHONE, "A1", true)

    await store.chats.rekeyChat(OWNER, PHONE, LID)

    const starred = await store.messages.messages(OWNER, LID, { limit: 10, starred: true })
    expect(starred.items.map((one) => one.id)).toEqual(["A1", "A2", "A3"])
    await store.close()
  })

  it("carries receipts into the merged chat, the copy that got further winning", async () => {
    const path = fresh()
    const store = await openStore({ path })
    const own = (id: string, chatId: string): Message => ({ ...message(id, chatId, "sent"), outgoing: true })
    await store.messages.saveMessages(OWNER, PHONE, [own("A1", PHONE), own("A2", PHONE)], { via: "history" })
    await store.messages.saveMessages(OWNER, LID, [own("A2", LID)], { via: "history" })
    await store.messages.saveDelivery(OWNER, PHONE, "A1", "delivered")
    await store.messages.saveDelivery(OWNER, PHONE, "A2", "read")
    await store.messages.saveDelivery(OWNER, LID, "A2", "delivered")

    await store.chats.rekeyChat(OWNER, PHONE, LID)

    const page = await store.messages.messages(OWNER, LID, { limit: 10 })
    expect(page.items.map((one) => [one.id, one.delivery])).toEqual([
      ["A1", "delivered"],
      ["A2", "read"],
    ])
    await store.close()
  })

  it("keeps a deletion when only one copy of a message held twice was deleted", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.messages.saveMessages(OWNER, PHONE, [message("A2", PHONE, "gone at the source")], { via: "history" })
    await store.messages.saveMessages(OWNER, LID, [message("A2", LID, "gone at the source")], { via: "history" })
    await store.messages.markDeleted(OWNER, ["A2"], { chatId: LID })

    await store.chats.rekeyChat(OWNER, PHONE, LID)

    expect(await raw(path, "SELECT text, deleted_at IS NOT NULL AS gone FROM messages")).toEqual([
      { text: "", gone: 1 },
    ])
    expect(await store.messages.countMessages(OWNER, LID)).toBe(0)
    await store.close()
  })

  it("keeps a deletion of the old copy, and brings nothing of the live twin back", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.messages.saveMessages(OWNER, PHONE, [message("A2", PHONE, "gone at the source")], { via: "history" })
    await store.messages.markDeleted(OWNER, ["A2"], { chatId: PHONE })
    await store.messages.saveMessages(OWNER, LID, [message("A2", LID, "gone at the source")], { via: "history" })
    await store.tags.addTags(OWNER, { type: "message", chatId: LID, messageId: "A2" }, ["secret"])
    await store.messages.keepTranscript(OWNER, LID, "A2", "spoken secret", "whatsapp")
    await store.messages.saveVote(OWNER, LID, "A2", {
      person: { id: "7", name: "Ana", username: null },
      answers: ["1"],
      votedAt: "2026-10-18T10:00:00.000Z",
    })
    const database = await openCache(path)
    database
      .prepare(
        "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, created_at, updated_at) SELECT 'note', 1, 'message', m.id, 'mentions', 'owner', 0, 0 FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.external_id = ?",
      )
      .run(LID)
    database.close()

    await store.chats.rekeyChat(OWNER, PHONE, LID)

    expect(await raw(path, "SELECT text, deleted_at IS NOT NULL AS gone FROM messages")).toEqual([
      { text: "", gone: 1 },
    ])
    expect(await store.tags.tags(OWNER)).toEqual([])
    expect(await store.messages.transcript(OWNER, LID, "A2")).toBeUndefined()
    expect(await store.messages.pollVotes(OWNER, LID, "A2")).toEqual([])
    expect(await raw(path, "SELECT count(*) AS n FROM links JOIN messages m ON m.id = links.to_id")).toEqual([{ n: 1 }])
    await store.close()
  })

  it("merges two chats that both carry the same automatic tag", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana"), chat(LID, "Ana")])
    const match = [{ tag: "family", score: 1, fields: ["title"] }]
    await store.chats.replaceAutoTags(OWNER, PHONE, "keywords-1", match)
    await store.chats.replaceAutoTags(OWNER, LID, "keywords-1", match)
    expect(await raw(path, "SELECT count(*) AS n FROM canonical_auto_tag_claims")).toEqual([{ n: 2 }])

    expect((await store.chats.rekeyChat(OWNER, PHONE, LID)).outcome).toBe("merged")
    expect(await raw(path, "SELECT count(*) AS n FROM canonical_auto_tag_claims")).toEqual([{ n: 1 }])
    await store.close()
  })

  it("keeps the people of the chat it merges in", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana"), chat(LID, "Ana")])
    await store.roster.saveMembers(OWNER, LID, ["7", "8"])

    await store.chats.rekeyChat(OWNER, PHONE, LID)

    expect((await store.roster.members(OWNER, LID)).map((one) => one.id).sort()).toEqual(["7", "8"])
    expect(await raw(path, "SELECT count(*) AS n FROM involvements WHERE subject_type = 'chat'")).toEqual([{ n: 2 }])
    await store.close()
  })

  it("merges one person's open stays in both chats into one, earliest seen to latest", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.chats.saveChats(OWNER, [chat(PHONE, "Team", "group"), chat(LID, "Team", "group")])
    const read = (observedAt: string, joinedAt: string | undefined, role: "admin" | "member") => ({
      observation: { observedAt, source: "remote_fetch" as const },
      members: [{ id: "7", name: "Ana", username: null, role, ...(joinedAt ? { joinedAt } : {}) }],
      complete: true,
      participants: 1,
    })
    await store.roster.saveRoster(OWNER, PHONE, read("2026-10-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z", "member"))
    await store.roster.saveRoster(OWNER, LID, read("2026-10-10T10:00:00.000Z", undefined, "admin"))

    expect((await store.chats.rekeyChat(OWNER, PHONE, LID)).outcome).toBe("merged")

    expect(await raw(path, "SELECT first_seen_at, last_seen_at, joined_at, role, left_at FROM member_stays")).toEqual([
      {
        first_seen_at: Date.parse("2026-10-01T10:00:00.000Z"),
        last_seen_at: Date.parse("2026-10-10T10:00:00.000Z"),
        joined_at: Date.parse("2026-09-01T10:00:00.000Z"),
        role: "admin",
        left_at: null,
      },
    ])
    expect(await raw(path, "SELECT count(*) AS n FROM member_observation_members")).toEqual([{ n: 2 }])
    await store.close()
  })

  it("is not left when the chat list named the new id before the re-key landed", async () => {
    const store = await openStore({ path: fresh() })
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana")])
    await store.chats.saveChats(OWNER, [chat(LID, "Ana")])
    await store.chats.markChatsLeft(OWNER, [LID])

    await store.chats.rekeyChat(OWNER, PHONE, LID)

    expect(await store.chats.leftChats(OWNER)).toEqual({ chats: 0, messages: 0, left: [] })
    await store.close()
  })

  it("keeps the phone-side state of both copies on a merge, the new id's where both say", async () => {
    const store = await openStore({ path: fresh() })
    await store.chats.saveChats(OWNER, [
      { ...chat(PHONE, "Ana"), muted: true, mutedUntil: "2099-01-01T00:00:00.000Z", markedUnread: true },
      { ...chat(LID, "Ana"), muted: true, archived: true },
    ])

    await store.chats.rekeyChat(OWNER, PHONE, LID)

    const [merged] = (await store.chats.chats(OWNER, {})).items
    expect(merged).toMatchObject({ id: LID, muted: true, archived: true, markedUnread: true })
    expect(merged?.mutedUntil).toBeUndefined()
    await store.close()
  })

  it("stays left when the chat list named neither id", async () => {
    const store = await openStore({ path: fresh() })
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana"), chat(LID, "Ana"), chat("9@lid", "Bo")])
    await store.chats.markChatsLeft(OWNER, ["9@lid"])

    await store.chats.rekeyChat(OWNER, PHONE, LID)

    expect(await store.chats.leftChats(OWNER)).toEqual({
      chats: 1,
      messages: 0,
      left: [{ id: LID, title: "Ana", messages: 0 }],
    })
    await store.close()
  })

  it("changes nothing on a replay, an unknown chat, or another account's chat of the same id", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.messages.saveMessages(OWNER, PHONE, [message("A1", PHONE, "mine")], { via: "history" })
    await store.messages.saveMessages(OTHER, PHONE, [message("A1", PHONE, "theirs")], { via: "history" })
    await store.messages.saveMessages(OTHER, LID, [message("A2", LID, "theirs too")], { via: "history" })

    expect((await store.chats.rekeyChat(OWNER, PHONE, LID)).outcome).toBe("renamed")
    expect((await store.chats.rekeyChat(OWNER, PHONE, LID)).outcome).toBe("unchanged")
    expect((await store.chats.rekeyChat(OWNER, "nobody@s.whatsapp.net", LID)).outcome).toBe("unchanged")
    expect((await store.chats.rekeyChat(OWNER, LID, LID)).outcome).toBe("unchanged")
    expect((await store.chats.rekeyChat({ provider: "whatsapp", account: "3@lid" }, PHONE, LID)).outcome).toBe(
      "unchanged",
    )

    expect(await texts(store, LID)).toEqual(["mine"])
    expect((await store.messages.messages(OTHER, PHONE, { limit: 5 })).items.map((one) => one.text)).toEqual(["theirs"])
    expect((await store.messages.messages(OTHER, LID, { limit: 5 })).items.map((one) => one.text)).toEqual([
      "theirs too",
    ])
    await store.close()
  })

  it.each([
    { phone: 1, lid: 0, merged: 0 },
    { phone: 0, lid: 1, merged: 0 },
    { phone: 1, lid: 1, merged: 1 },
  ])(
    "keeps a chat hidden from search when either half was (phone $phone, lid $lid)",
    async ({ phone, lid, merged }) => {
      const path = fresh()
      const store = await openStore({ path })
      await store.chats.saveChats(OWNER, [chat(PHONE, "Ana"), chat(LID, "Ana")])
      await settle(path, OWNER, PHONE, { searchable: phone, scope: null })
      await settle(path, OWNER, LID, { searchable: lid, scope: null })

      expect((await store.chats.rekeyChat(OWNER, PHONE, LID)).outcome).toBe("merged")

      expect(await settings(path, OWNER)).toEqual([{ id: LID, searchable: merged, scope: null }])
      await store.close()
    },
  )

  it.each([
    { account: "work", phone: "work", lid: "personal", merged: "personal" },
    { account: "work", phone: "personal", lid: "work", merged: "personal" },
    { account: "work", phone: "work", lid: null, merged: "work" },
    { account: "work", phone: null, lid: "personal", merged: "personal" },
    { account: "personal", phone: "work", lid: null, merged: "personal" },
    { account: "personal", phone: null, lid: "work", merged: "personal" },
    { account: "personal", phone: null, lid: null, merged: null },
    { account: "personal", phone: null, lid: "personal", merged: "personal" },
    { account: "personal", phone: "personal", lid: null, merged: "personal" },
    { account: "work", phone: null, lid: "work", merged: "work" },
  ])(
    "keeps the personal side when the halves differ, and pins any scope either half pinned (account $account, phone $phone, lid $lid)",
    async ({ account, phone, lid, merged }) => {
      const path = fresh()
      const store = await openStore({ path })
      await store.chats.saveChats(OWNER, [chat(PHONE, "Ana"), chat(LID, "Ana")])
      await accountScope(path, OWNER, account)
      await settle(path, OWNER, PHONE, { searchable: 1, scope: phone })
      await settle(path, OWNER, LID, { searchable: 1, scope: lid })

      await store.chats.rekeyChat(OWNER, PHONE, LID)

      expect(await settings(path, OWNER)).toEqual([{ id: LID, searchable: 1, scope: merged }])
      await store.close()
    },
  )

  it.each([
    { phone: null, lid: "personal" },
    { phone: "personal", lid: null },
  ])(
    "keeps a personal pin on either half when the account default later turns to work (phone $phone, lid $lid)",
    async ({ phone, lid }) => {
      const path = fresh()
      const store = await openStore({ path })
      await store.chats.saveChats(OWNER, [chat(PHONE, "Ana"), chat(LID, "Ana")])
      await settle(path, OWNER, PHONE, { searchable: 1, scope: phone })
      await settle(path, OWNER, LID, { searchable: 1, scope: lid })

      await store.chats.rekeyChat(OWNER, PHONE, LID)
      await accountScope(path, OWNER, "work")

      expect(
        await raw(
          path,
          "SELECT coalesce(c.scope, a.scope) AS scope FROM chats c JOIN accounts a ON a.id = c.account_id WHERE a.external_id = ?",
          OWNER.account,
        ),
      ).toEqual([{ scope: "personal" }])
      await store.close()
    },
  )

  it("never reads or changes another account's chats of the same ids when it merges", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana"), chat(LID, "Ana")])
    await store.chats.saveChats(OTHER, [chat(PHONE, "Ana"), chat(LID, "Ana")])
    await settle(path, OWNER, PHONE, { searchable: 1, scope: "work" })
    await settle(path, OWNER, LID, { searchable: 1, scope: "work" })
    await settle(path, OTHER, PHONE, { searchable: 0, scope: "personal" })
    await settle(path, OTHER, LID, { searchable: 1, scope: null })
    const before = await settings(path, OTHER)

    await store.chats.rekeyChat(OWNER, PHONE, LID)

    expect(await settings(path, OWNER)).toEqual([{ id: LID, searchable: 1, scope: "work" }])
    expect(await settings(path, OTHER)).toEqual(before)
    await store.close()
  })

  it("refuses to merge a one-to-one chat into a group", async () => {
    const store = await openStore({ path: fresh() })
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana"), chat(LID, "Team", "group")])

    await expect(store.chats.rekeyChat(OWNER, PHONE, LID)).rejects.toMatchObject({ code: "validation_error" })
    expect((await store.chats.chats(OWNER, {})).items.map((one) => one.id).sort()).toEqual([PHONE, LID].sort())
    await store.close()
  })
})

describe("re-keying a run of chats in one pass", () => {
  const GROUP_PHONE = "34600000002@s.whatsapp.net"
  const GROUP_LID = "778@lid"
  const MERGED_PHONE = "34600000003@s.whatsapp.net"
  const MERGED_LID = "779@lid"

  it("**applies each pair as `rekeyChat` would, in order**, a refused one leaving the others and another account alone", async () => {
    const path = fresh()
    const store = await openStore({ path })
    const owned = [
      chat(PHONE, "Ana"),
      chat(GROUP_PHONE, "Ben"),
      chat(GROUP_LID, "Team", "group"),
      chat(MERGED_PHONE, "Eva"),
      chat(MERGED_LID, "Eva"),
    ]
    await store.chats.saveChats(OWNER, owned)
    await store.chats.saveChats(OTHER, owned)
    await settle(path, OWNER, MERGED_PHONE, { searchable: 1, scope: "work" })
    await settle(path, OWNER, MERGED_LID, { searchable: 1, scope: "personal" })
    const before = await settings(path, OTHER)

    const pass = await store.chats.rekeyChats(
      OWNER,
      [
        { from: PHONE, to: LID },
        { from: GROUP_PHONE, to: GROUP_LID },
        { from: MERGED_PHONE, to: MERGED_LID },
      ],
      60_000,
    )

    expect(pass.taken).toBe(3)
    expect(pass.applied.map(({ from, rekey }) => [from, rekey.outcome])).toEqual([
      [PHONE, "renamed"],
      [MERGED_PHONE, "merged"],
    ])
    expect(pass.refused).toEqual([
      { from: GROUP_PHONE, to: GROUP_LID, error: expect.objectContaining({ code: "validation_error" }) },
    ])
    expect(await settings(path, OWNER)).toEqual(
      [
        { id: LID, searchable: 1, scope: null },
        { id: GROUP_PHONE, searchable: 1, scope: null },
        { id: GROUP_LID, searchable: 1, scope: null },
        { id: MERGED_LID, searchable: 1, scope: "personal" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    )
    expect(await settings(path, OTHER)).toEqual(before)
    await store.close()
  })

  it("stops after the first pair once its lock time is spent, and says how far it got", async () => {
    const store = await openStore({ path: fresh() })
    await store.chats.saveChats(OWNER, [chat(PHONE, "Ana"), chat(GROUP_PHONE, "Ben")])

    const pass = await store.chats.rekeyChats(
      OWNER,
      [
        { from: PHONE, to: LID },
        { from: GROUP_PHONE, to: GROUP_LID },
      ],
      0,
    )

    expect(pass.taken).toBe(1)
    expect((await store.chats.chats(OWNER, {})).items.map((one) => one.id).sort()).toEqual([GROUP_PHONE, LID].sort())
    await store.close()
  })
})
