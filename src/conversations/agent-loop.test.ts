import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { conversationsService } from "../services/conversations.js"
import { storedDeps } from "../services/deps.js"
import { openStore } from "../store/store.js"

const account = { provider: "test", account: "1" }

/** A chat whose true parents are known: each message answers one of the 40 before it, or starts anew. */
const goldChat = (count: number, seed = 7) => {
  let state = seed
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31
    return state / 2 ** 31
  }
  const parents = new Map<string, string | null>()
  const messages: Message[] = []
  for (let n = 1; n <= count; n++) {
    const parent = n === 1 || random() < 0.2 ? null : String(n - 1 - Math.floor(random() * Math.min(n - 1, 40)))
    parents.set(String(n), parent)
    // A tenth of the answers the messenger records itself, as a reply.
    const reply = parent !== null && random() < 0.1 ? { replyToId: parent } : {}
    messages.push({
      id: String(n),
      chatId: "9",
      senderId: String(100 + Math.floor(random() * 30)),
      senderName: null,
      timestamp: new Date(Date.parse("2026-10-01T00:00:00Z") + n * 3_600_000).toISOString(),
      editedAt: null,
      text: `message ${n}`,
      outgoing: false,
      attachments: [],
      replyTo: null,
      ...reply,
      forwardedFrom: null,
      reactions: null,
    })
  }
  return { parents, messages }
}

const groupsOf = (parents: Map<string, string | null>) => {
  const root = new Map<string, string>()
  for (const [id, parent] of parents) root.set(id, parent === null ? id : (root.get(parent) ?? id))
  const groups = new Map<string, string[]>()
  for (const [id, top] of root) groups.set(top, [...(groups.get(top) ?? []), id])
  return [...groups.values()].map((ids) => ids.join(",")).sort()
}

describe("the agent loop, end to end", () => {
  it("**reproduces the true conversations** when the agent answers every batch from them", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "loop-")), "m.db") })
    await store.saveChats(account, [
      { id: "9", title: "Group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    const { parents, messages } = goldChat(400)
    await store.saveMessages(account, "9", messages, { via: "history" })
    const conversations = conversationsService(
      storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard),
    )

    await conversations.build("9")
    let batches = 0
    for (let batch = await conversations.nextBatch("9", 50); batch; batch = await conversations.nextBatch("9", 50)) {
      batches += 1
      const answers = batch.messages
        .filter(({ answer }) => answer)
        .map(({ id }) => ({ message: id, parent: parents.get(id) ?? null, confidence: 1 }))
      expect((await conversations.addAnswers(batch.batch, { model: "gold", answers })).stored).toBe(answers.length)
    }
    await conversations.build("9")

    const page = await conversations.list("9", { limit: 1000 })
    expect(page.has_more).toBe(false)
    const built = await Promise.all(
      page.items.map(async ({ id }) => (await conversations.show({ id })).messages.map((one) => one.id).join(",")),
    )
    expect(batches).toBeGreaterThan(5)
    expect(built.sort()).toEqual(groupsOf(parents))
    await store.close()
  }, 30_000)
})
