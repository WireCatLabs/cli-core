import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const ME: AccountKey = { provider: "telegram", account: "100" }

const chat = (id: string, title = `Chat ${id}`): Chat => ({
  id,
  title,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
})

let minute = 0
const message = (chatId: string, id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  chatId,
  senderId: "7",
  senderName: "Ana",
  timestamp: new Date(Date.UTC(2026, 8, 1, 10, minute++)).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const opened = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "words-")), "messages.db")
  const store = await openStore({ path })
  stores.push(store)
  await store.chats.saveChats(ME, [chat("1"), chat("2", "Hidden")])
  return { store, path }
}

describe("the typo vocabulary", () => {
  it("**knows a whole word or the beginning of one**", async () => {
    const { store } = await opened()
    await store.messages.saveMessages(ME, "1", [message("1", "1", "квартиру в Валенсии")], { via: "history" })

    expect(await store.searchIndex.knownTerms(["квартир", "квартиру", "Валенсии", "valenca"])).toEqual(
      new Set(["квартир", "квартиру", "Валенсии"]),
    )
  })

  it("**offers words sharing trigrams that the index still has** — not one whose message was deleted", async () => {
    const { store } = await opened()
    await store.messages.saveMessages(ME, "1", [message("1", "1", "valencia"), message("1", "2", "valence")], {
      via: "history",
    })
    await store.searchIndex.fillSearchIndex()
    await store.messages.markDeleted(ME, ["2"], { chatId: "1" })
    const pieces = ["  v", " va", "val", "ale", "len", "enc", "nca", "ca "]

    expect(await store.searchIndex.termCandidates(pieces, { shortest: 5, longest: 9 })).toEqual([
      { term: "valencia", docs: 1 },
    ])
  })
})
