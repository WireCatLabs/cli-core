import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Message, PersonReaction } from "../domain/models.js"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const owner = { provider: "whatsapp", account: "1" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const message = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: "2026-10-01T10:00:00.000Z",
  editedAt: null,
  text: "Lunch?",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})

const by = (id: string, reaction: string | null, minute: number, own = false): PersonReaction => ({
  person: { id, name: null, username: null },
  own,
  reaction,
  reactedAt: `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`,
})

const setUp = async (messages: Message[] = [message("40")]) => {
  const path = join(mkdtempSync(join(tmpdir(), "reactions-")), "wirecat.db")
  const store = await openStore({ path })
  opened.push(store)
  if (messages.length > 0) await store.messages.saveMessages(owner, "7", messages, { via: "history" })
  const react = (reaction: PersonReaction, messageId = "40") =>
    store.messages.saveReaction(owner, "7", messageId, reaction)
  const totals = async (messageId = "40") =>
    (await store.messages.message(owner, messageId, { chatId: "7" }))?.reactions
  return { path, store, react, totals }
}

describe("people's reactions in the store", () => {
  it("a reaction, a change and a take-back each leave the totals as they now are", async () => {
    const { react, totals } = await setUp()

    await react(by("9", "👍", 1))
    expect(await totals()).toEqual({ counts: [{ reaction: "👍", count: 1 }], mine: null, total: 1 })

    await react(by("9", "❤️", 2))
    expect(await totals()).toEqual({ counts: [{ reaction: "❤️", count: 1 }], mine: null, total: 1 })

    await react(by("9", null, 3))
    expect(await totals()).toEqual({ counts: [], mine: null, total: 0 })
  })

  it("an older change arriving late does not replace a newer one, a take-back included", async () => {
    const { react, totals } = await setUp()

    await react(by("9", null, 5))
    await react(by("9", "👍", 2))

    expect(await totals()).toEqual({ counts: [], mine: null, total: 0 })
  })

  it("a pushed history older than a live change does not bring the old reaction back", async () => {
    const { store, react, totals } = await setUp()
    await react(by("9", "❤️", 5))

    await store.messages.saveMessages(owner, "7", [message("40")], {
      via: "history",
      reactions: [{ messageId: "40", reaction: by("9", "👍", 1) }],
    })

    expect(await totals()).toEqual({ counts: [{ reaction: "❤️", count: 1 }], mine: null, total: 1 })
  })

  it("counts two people in a group, most used first, the owner's own as `mine`", async () => {
    const { react, totals } = await setUp()

    await react(by("9", "👍", 1))
    await react(by("1", "❤️", 2, true))
    await react(by("10", "❤️", 3))

    expect(await totals()).toEqual({
      counts: [
        { reaction: "❤️", count: 2 },
        { reaction: "👍", count: 1 },
      ],
      mine: "❤️",
      total: 3,
    })
  })

  it("lists each person's newest reaction, newest first, without the ones taken back", async () => {
    const { store, react } = await setUp()

    await react(by("9", "👍", 1))
    await react(by("10", "❤️", 2))
    await react(by("11", "🔥", 3))
    await react(by("9", "😮", 4))
    await react(by("10", null, 5))
    await react(by("11", "🔥", 3))

    expect(await store.messages.reactors(owner, "7", "40")).toEqual([
      { person: { id: "9", name: "Olga", username: null }, reaction: "😮", reactedAt: "2026-10-01T10:04:00.000Z" },
      { person: { id: "11", name: null, username: null }, reaction: "🔥", reactedAt: "2026-10-01T10:03:00.000Z" },
    ])
  })

  it("lists nobody for a message or chat the store holds no reactions for", async () => {
    const { store } = await setUp()

    expect(await store.messages.reactors(owner, "7", "41")).toEqual([])
    expect(await store.messages.reactors(owner, "8", "40")).toEqual([])
  })

  it("a reaction to a message not stored yet shows once the message arrives", async () => {
    const { store, react, totals } = await setUp([])

    await react(by("9", "👍", 1))
    await store.messages.saveMessages(owner, "7", [message("40")], { via: "history" })

    expect(await totals()).toEqual({ counts: [{ reaction: "👍", count: 1 }], mine: null, total: 1 })
  })

  it("an edit or the messenger's own totals do not overwrite totals made from people's reactions", async () => {
    const { store, react, totals } = await setUp()
    await react(by("9", "👍", 1))

    await store.messages.saveMessages(
      owner,
      "7",
      [message("40", { text: "Lunch at 2?", editedAt: "2026-10-01T10:05:00.000Z" })],
      {
        via: "update",
      },
    )
    await store.messages.saveReactions(owner, "7", "40", {
      counts: [{ reaction: "😮", count: 4 }],
      mine: null,
      total: 4,
    })

    expect(await totals()).toEqual({ counts: [{ reaction: "👍", count: 1 }], mine: null, total: 1 })
  })

  it("a message without people's reactions keeps the messenger's totals", async () => {
    const { store, totals } = await setUp()
    const counted = { counts: [{ reaction: "👍", count: 3 }], mine: "👍", total: 3 }

    await store.messages.saveReactions(owner, "7", "40", counted)

    expect(await totals()).toEqual(counted)
  })

  it("a deleted message keeps no people's reactions and takes none after", async () => {
    const { path, store, react } = await setUp()
    await react(by("9", "👍", 1))
    await store.messages.markDeleted(owner, ["40"], { chatId: "7" })

    await react(by("10", "😮", 2))

    const database = await openCache(path)
    expect(database.prepare("SELECT count(*) AS held FROM message_reactions").get()).toEqual({ held: 0 })
    database.close()
  })
})
