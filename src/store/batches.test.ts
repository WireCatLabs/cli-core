import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { openCache } from "./open.js"
import { BATCH_CONTEXT } from "./sqlite/batches.js"
import { type AccountKey, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "tg", account: "1" }

const message = (n: number, replyToId?: string): Message => ({
  id: String(n),
  chatId: "-1",
  senderId: String(7 + (n % 3)),
  senderName: null,
  timestamp: new Date(Date.parse("2026-10-01T00:00:00Z") + n * 60_000).toISOString(),
  editedAt: null,
  text: `message ${n}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  ...(replyToId ? { replyToId } : {}),
  forwardedFrom: null,
  reactions: null,
})

const chatOf = async (count: number, replies: Record<number, number> = {}) => {
  const path = join(mkdtempSync(join(tmpdir(), "batches-")), "messages.db")
  const store = await openStore({ path })
  await store.chats.saveChats(OWNER, [
    { id: "-1", title: "Group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  const all = Array.from({ length: count }, (_, i) =>
    message(i + 1, replies[i + 1] ? String(replies[i + 1]) : undefined),
  )
  await store.messages.saveMessages(OWNER, "-1", all, { via: "history" })
  return { store, path }
}

/** An agent answer for `id`, written as `links add` will write it. */
const answered = async (path: string, id: number, staleAt: number | null = null) => {
  const database = await openCache(path)
  database
    .prepare(
      `INSERT OR REPLACE INTO message_links (chat_id, message_id, parent_id, source, kind, confidence, method, created_at, stale_at, updated_at)
       SELECT chat_id, id, NULL, 'agent', 'answer', 0.9, 'model', 0, ?, 0 FROM messages WHERE external_id = ?`,
    )
    .run(staleAt, String(id))
  database.close()
}

const ids = (messages: { id: string; answer: boolean }[], answer: boolean) =>
  messages.filter((one) => one.answer === answer).map(({ id }) => Number(id))

describe("batches for the user's agent", () => {
  it("**cuts a window**: the first unanswered message, the next `size`, and the 50 before it as context", async () => {
    const { store, path } = await chatOf(200)
    for (let id = 1; id <= 120; id++) await answered(path, id)

    const batch = await store.conversations.nextBatch(OWNER, "-1", { size: 30 })

    expect(ids(batch?.messages ?? [], true)).toEqual(Array.from({ length: 30 }, (_, i) => 121 + i))
    expect(ids(batch?.messages ?? [], false)).toEqual(Array.from({ length: BATCH_CONTEXT }, (_, i) => 71 + i))
    expect(batch?.batch).toMatch(/^b1\.\d+\.\d+\.\d+\.[0-9a-f]{12}$/)
    expect(batch?.remaining).toEqual({ messages: 50, characters: 50 * "message 1xx".length })
    await store.close()
  })

  it("keeps a message the messenger records as a reply for context, never to answer", async () => {
    const { store } = await chatOf(5, { 3: 2 })

    const batch = await store.conversations.nextBatch(OWNER, "-1", { size: 50 })

    expect(ids(batch?.messages ?? [], true)).toEqual([1, 2, 4, 5])
    expect(batch?.messages.find(({ id }) => id === "3")).toMatchObject({ answer: false, replyTo: "2" })
    expect(await store.conversations.batchStatus(OWNER, "-1")).toEqual({
      messages: 4,
      characters: 4 * "message 1".length,
    })
    await store.close()
  })

  it("asks again about a message whose answer went stale, and about nothing once all are answered", async () => {
    const { store, path } = await chatOf(3)
    await answered(path, 1)
    await answered(path, 2, 1)
    await answered(path, 3)

    expect(ids((await store.conversations.nextBatch(OWNER, "-1", { size: 50 }))?.messages ?? [], true)).toEqual([2])
    await answered(path, 2)
    expect(await store.conversations.nextBatch(OWNER, "-1", { size: 50 })).toBeUndefined()
    expect(await store.conversations.nextBatch(OWNER, "-404", { size: 50 })).toBeUndefined()
    await store.close()
  })
})

describe("the agent's answers", () => {
  const agentRows = async (path: string) => {
    const database = await openCache(path)
    try {
      return database
        .prepare(
          `SELECT m.external_id AS message, p.external_id AS parent, l.method, l.batch FROM message_links l
           JOIN messages m ON m.id = l.message_id LEFT JOIN messages p ON p.id = l.parent_id
           WHERE l.source = 'agent' ORDER BY m.sent_at`,
        )
        .all()
        .map((row) => ({ ...row }))
    } finally {
      database.close()
    }
  }

  it("**stores an answer** to a batch, replaces a message's earlier one, and stops asking about it", async () => {
    const { store, path } = await chatOf(5)
    const batch = (await store.conversations.nextBatch(OWNER, "-1", { size: 50 }))?.batch as string

    expect(
      await store.conversations.saveAnswers(OWNER, batch, {
        model: "m1",
        answers: [
          { message: "2", parent: "1", confidence: 0.9 },
          { message: "3", parent: null, confidence: 0.6 },
        ],
      }),
    ).toEqual({ chat: "-1", stored: 2 })
    await store.conversations.saveAnswers(OWNER, batch, {
      model: "m2",
      answers: [{ message: "2", parent: null, confidence: 0.5 }],
    })

    expect(await agentRows(path)).toEqual([
      { message: "2", parent: null, method: "m2", batch },
      { message: "3", parent: null, method: "m1", batch },
    ])
    expect(ids((await store.conversations.nextBatch(OWNER, "-1", { size: 50 }))?.messages ?? [], true)).toEqual([
      1, 4, 5,
    ])
    expect(await store.conversations.clearAnswers(OWNER, "-1", "m1")).toBe(1)
    expect(await store.conversations.clearAnswers(OWNER, "-1")).toBe(1)
    expect(await agentRows(path)).toEqual([])
    await store.close()
  })

  it("**refuses the whole answer**, storing nothing, when any part of it is wrong", async () => {
    const { store, path } = await chatOf(5, { 3: 2 })
    const batch = (await store.conversations.nextBatch(OWNER, "-1", { size: 50 }))?.batch as string
    const good = { message: "4", parent: "1", confidence: 0.8 }
    const refuse = (answer: Parameters<typeof store.conversations.saveAnswers>[2], why: RegExp) =>
      expect(store.conversations.saveAnswers(OWNER, batch, answer)).rejects.toThrow(why)

    await refuse(
      { model: "m", answers: [good, { message: "3", parent: "2", confidence: 1 }] },
      /not one this batch asks/,
    )
    await refuse({ model: "m", answers: [good, { message: "5", parent: "99", confidence: 1 }] }, /not in this batch/)
    await refuse({ model: "m", answers: [good, { message: "2", parent: "4", confidence: 1 }] }, /not earlier/)
    await refuse({ model: "m", answers: [good, good] }, /answered twice/)
    await refuse({ model: "m", answers: [{ ...good, confidence: 1.5 }] }, /between 0 and 1/)
    await refuse({ model: " ", answers: [good] }, /name the model/)
    await expect(store.conversations.saveAnswers(OWNER, "b1.x", { model: "m", answers: [] })).rejects.toThrow(
      /not a batch/,
    )
    expect(await agentRows(path)).toEqual([])
    await store.close()
  })

  it("keeps a batch valid after part of it is answered, not after a message inside it is deleted", async () => {
    const { store, path } = await chatOf(6)
    const batch = (await store.conversations.nextBatch(OWNER, "-1", { size: 4 }))?.batch as string
    await store.conversations.saveAnswers(OWNER, batch, {
      model: "m",
      answers: [{ message: "2", parent: "1", confidence: 1 }],
    })
    await store.messages.saveMessages(OWNER, "-1", [message(7)], { via: "history" })

    expect(
      await store.conversations.saveAnswers(OWNER, batch, {
        model: "m",
        answers: [{ message: "3", parent: "2", confidence: 1 }],
      }),
    ).toMatchObject({ stored: 1 })
    await store.messages.markDeleted(OWNER, ["3"], { chatId: "-1" })
    await expect(
      store.conversations.saveAnswers(OWNER, batch, {
        model: "m",
        answers: [{ message: "4", parent: "2", confidence: 1 }],
      }),
    ).rejects.toThrow(/changed under this batch/)
    expect((await agentRows(path)).map(({ message }) => message)).toEqual(["2", "3"])
    await store.close()
  })
})
