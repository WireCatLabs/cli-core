import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type LinkInput, linkMessages, RULES_VERSION } from "../conversations/link.js"
import type { Message } from "../domain/models.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "conversations-")), "messages.db")
const OWNER: AccountKey = { provider: "tg", account: "1" }
const OTHER: AccountKey = { provider: "tg", account: "2" }

const message = (id: string, sender: string, text: string, replyToId?: string): Message => ({
  id,
  chatId: "-1",
  senderId: sender,
  senderName: sender === "7" ? "Ana" : "Bo",
  senderUsername: sender === "7" ? "Ana_V" : "bo",
  timestamp: `2026-10-01T1${id}:00:00.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  ...(replyToId ? { replyToId } : {}),
  forwardedFrom: null,
  reactions: null,
})

const GROUP = [
  message("1", "7", "dentist anyone?"),
  message("2", "8", "Clínica X", "1"),
  message("3", "8", "and the TIE?"),
  message("4", "7", "Policía Nacional", "3"),
]

const opened = async (path = fresh()) => {
  const store = await openStore({ path, now: () => Date.parse("2026-10-01T20:00:00Z") })
  await store.chats.saveChats(OWNER, [
    { id: "-1", title: "Group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.messages.saveMessages(OWNER, "-1", GROUP, { via: "history" })
  return { store, path }
}

const everyInput = async (store: MessageStore, limit: number) => {
  const inputs: LinkInput[] = []
  let after: string | undefined
  for (;;) {
    const page = await store.conversations.linkInputs(OWNER, "-1", { limit, ...(after === undefined ? {} : { after }) })
    inputs.push(...page.items)
    if (page.next === null) return inputs
    after = page.next
  }
}

const build = async (store: MessageStore, startedAt = Date.parse("2026-10-01T20:00:00Z")) => {
  const handles = await store.conversations.senderHandles(OWNER, "-1")
  const answers = await store.conversations.agentAnswers(OWNER, "-1")
  const { links, conversations } = linkMessages(await everyInput(store, 3), { handles, answers })
  await store.conversations.replaceConversations(OWNER, "-1", {
    startedAt,
    algorithmVersion: RULES_VERSION,
    links,
    conversations,
  })
}

describe("conversations in the store", () => {
  it("**round trip**: pages of messages in, conversations and their links back out", async () => {
    const { store } = await opened()
    expect((await everyInput(store, 3)).map(({ id, replyToId }) => [id, replyToId])).toEqual([
      ["1", undefined],
      ["2", "1"],
      ["3", undefined],
      ["4", "3"],
    ])
    expect(await store.conversations.senderHandles(OWNER, "-1")).toEqual(
      new Map([
        ["ana_v", "7"],
        ["bo", "8"],
      ]),
    )

    await build(store)

    const page = await store.conversations.conversations(OWNER, "-1", { limit: 10 })
    expect(
      page.items.map(({ firstMessageId, messageCount, senders }) => [firstMessageId, messageCount, senders]),
    ).toEqual([
      ["3", 2, 2],
      ["1", 2, 2],
    ])
    const first = page.items[1]?.id as string
    expect((await store.conversations.conversation(OWNER, first))?.messages.map(({ id }) => id)).toEqual(["1", "2"])
    expect(await store.conversations.conversationOf(OWNER, "-1", "2")).toBe(first)
    expect(await store.conversations.links(OWNER, "-1", "2")).toMatchObject([
      { parentId: "1", source: "provider", kind: "reply", confidence: 1, stale: false },
    ])
    expect(await store.conversations.conversationState(OWNER, "-1")).toEqual({
      enabledAt: "2026-10-01T20:00:00.000Z",
      builtAt: "2026-10-01T20:00:00.000Z",
      algorithmVersion: RULES_VERSION,
    })
    await store.close()
  })

  it("keeps whom a message mentions by id, and hands it to the rules", async () => {
    const { store } = await opened()
    await store.messages.saveMessages(OWNER, "-1", [{ ...message("5", "8", "Ana, see above"), mentions: ["7"] }], {
      via: "history",
    })

    expect((await store.messages.messages(OWNER, "-1", { limit: 1 })).items[0]?.mentions).toEqual(["7"])
    expect((await everyInput(store, 10)).at(-1)?.mentions).toEqual(["7"])
    await store.close()
  })

  it("**a rebuild keeps the agent's links**, and marks one stale when its message changed after it", async () => {
    const { store, path } = await opened()
    await build(store)
    await store.close()
    const database = await openCache(path)
    database
      .prepare(
        `INSERT INTO message_links (chat_id, message_id, parent_id, source, kind, confidence, method, created_at,updated_at)
         SELECT m.chat_id, m.id, p.id, 'agent', 'answer', 0.9, 'model', 0
         ,0 FROM messages m JOIN messages p ON p.external_id = '2' WHERE m.external_id = '3'`,
      )
      .run()
    database.close()

    const again = await openStore({ path })
    await again.messages.saveMessages(OWNER, "-1", [message("3", "8", "and the TIE appointment?")], { via: "update" })
    await build(again, Date.parse("2026-10-02T12:00:00Z"))

    expect(await again.conversations.links(OWNER, "-1", "3")).toMatchObject([
      { parentId: "2", source: "agent", stale: true },
    ])
    expect((await again.conversations.links(OWNER, "-1", "2")).map(({ source }) => source)).toEqual(["provider"])
    await again.close()
  })

  it("**builds with the agent's current answers**, not one whose message changed after it", async () => {
    const { store, path } = await opened()
    const database = await openCache(path)
    const answer = (message: string, parent: string) =>
      database
        .prepare(
          `INSERT INTO message_links (chat_id, message_id, parent_id, source, kind, confidence, method, created_at,updated_at)
           SELECT m.chat_id, m.id, p.id, 'agent', 'answer', 0.9, 'model', ?
           ,0 FROM messages m JOIN messages p ON p.external_id = ? WHERE m.external_id = ?`,
        )
        .run(Date.parse("2026-10-01T19:00:00Z"), parent, message)
    answer("3", "2")
    answer("4", "1")
    database.close()
    expect([...(await store.conversations.agentAnswers(OWNER, "-1"))]).toEqual([
      ["3", "2"],
      ["4", "1"],
    ])

    await store.messages.saveMessages(OWNER, "-1", [message("4", "7", "Policía Nacional, calle X", "3")], {
      via: "update",
    })
    await build(store, Date.parse("2026-10-02T12:00:00Z"))

    expect(await store.conversations.agentAnswers(OWNER, "-1")).toEqual(new Map([["3", "2"]]))
    const page = await store.conversations.conversations(OWNER, "-1", { limit: 10 })
    expect(page.items.map(({ firstMessageId, messageCount }) => [firstMessageId, messageCount])).toEqual([["1", 4]])
    expect(await store.conversations.links(OWNER, "-1", "4")).toMatchObject([
      { source: "provider" },
      { source: "agent", stale: true },
    ])
    await store.close()
  })

  it("**a failed build leaves the previous one** in place", async () => {
    const { store } = await opened()
    await build(store)
    const before = await store.conversations.conversations(OWNER, "-1", { limit: 10 })

    await expect(
      store.conversations.replaceConversations(OWNER, "-1", {
        startedAt: 1,
        algorithmVersion: RULES_VERSION,
        links: [],
        conversations: [
          ["3", "4"],
          ["1", "2", "2"],
        ],
      }),
    ).rejects.toThrow(/conversation_messages/)

    expect(await store.conversations.conversations(OWNER, "-1", { limit: 10 })).toEqual(before)
    await store.close()
  })

  it("**keeps one build**: a rebuild, and one after a failed build, leave only the current build's rows", async () => {
    const { store, path } = await opened()
    await build(store)
    const rows = async () => {
      const database = await openCache(path)
      try {
        return ["message_links", "conversations", "conversation_messages"].map((table) =>
          Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n),
        )
      } finally {
        database.close()
      }
    }
    const once = await rows()

    await expect(
      store.conversations.replaceConversations(OWNER, "-1", {
        startedAt: 1,
        algorithmVersion: RULES_VERSION,
        links: [],
        conversations: [["1", "2", "2"]],
      }),
    ).rejects.toThrow(/conversation_messages/)
    await build(store)

    expect(await rows()).toEqual(once)
    expect((await store.conversations.conversationState(OWNER, "-1"))?.algorithmVersion).toBe(RULES_VERSION)
    await store.close()
  })

  it("builds one conversation of 200,000 messages", async () => {
    const { store, path } = await opened()
    await store.close()
    const database = await openCache(path)
    database
      .prepare(
        `INSERT INTO messages (account_id, chat_id, external_id, text, sent_at, created_at, source, updated_at)
         WITH RECURSIVE n(i) AS (SELECT 100 UNION ALL SELECT i + 1 FROM n WHERE i < 200099)
         SELECT account_id, chat_id, i, '', i, 0, 'history', 0 FROM messages, n WHERE external_id = '1'`,
      )
      .run()
    database.close()
    const again = await openStore({ path })
    const ids = Array.from({ length: 200_000 }, (_, index) => String(index + 100))

    await again.conversations.replaceConversations(OWNER, "-1", {
      startedAt: 1,
      algorithmVersion: 1,
      links: [],
      conversations: [ids],
    })

    expect((await again.conversations.conversations(OWNER, "-1", { limit: 1 })).items[0]).toMatchObject({
      messageCount: 200_000,
    })
    await again.close()
  }, 30_000)

  it("**are derived**: dropping the four tables leaves every message and search result as it was", async () => {
    const { store, path } = await opened()
    await build(store)
    const read = async (from: MessageStore) => ({
      messages: await from.messages.messages(OWNER, "-1", { limit: 10 }),
      found: await from.messages.find({ text: "TIE", account: OWNER, limit: 10 }),
    })
    const before = await read(store)
    await store.close()
    const database = await openCache(path)
    for (const table of ["conversation_messages", "conversations", "message_links", "conversation_state"]) {
      database.exec(`DROP TABLE ${table}`)
    }
    database.close()

    const again = await openStore({ path })
    expect(await read(again)).toEqual(before)
    await again.close()
  })

  it("shows a conversation only to the account it belongs to", async () => {
    const { store } = await opened()
    await build(store)
    const [newest] = (await store.conversations.conversations(OWNER, "-1", { limit: 1 })).items
    await store.accounts.saveAccount(OTHER, { name: null })

    expect(await store.conversations.conversation(OTHER, newest?.id as string)).toBeUndefined()
    expect(await store.conversations.conversation(OWNER, "not a number")).toBeUndefined()
    await store.close()
  })
})
