import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { prepareLucene } from "../services/messages-search.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const account: AccountKey = { provider: "synthetic", account: "500" }
const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})
const message = (id: string, text: string): Message => ({
  id,
  chatId: "101",
  senderId: "700",
  senderName: "Mira",
  timestamp: `2026-10-0${id}T12:00:00.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const opened = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "word-rank-")), "store.db") })
  stores.push(store)
  await store.chats.saveChats(account, [
    { id: "101", title: "Decisions", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 20 },
  ])
  // The oldest message holds every word, so relevance and date disagree.
  await store.messages.saveMessages(
    account,
    "101",
    [
      message("1", "aurora rollout budget: the aurora rollout budget is final"),
      message("2", "lunch is ok, aurora maybe"),
      message("3", "the budget meeting moved"),
    ],
    { via: "synthetic" },
  )
  await store.searchIndex.fillSearchIndex({})
  await store.searchIndex.fillStems({})
  return store
}
// The query shape embeddings-search byWords builds: `word*` for 3+ characters, `"word"` below, joined by OR. It reads
// either one chosen chat or every chat with a per-chat cap.
const modes = {
  "across chats": { perChat: 20 },
  "in one chat": { chat: { account, chatId: "101" } },
}
const search = async (store: MessageStore, text: string, mode: keyof typeof modes) => {
  const { execution } = await prepareLucene(store, account, { text, accounts: [account], limit: 20 }, {})
  const { items } = await store.queries.matchQuery({ ...execution, ...modes[mode] })
  return items.map(({ id, score }) => ({ id, score }))
}

describe.each(Object.keys(modes) as (keyof typeof modes)[])("ranking an OR of optional words %s", (mode) => {
  it.each([
    ["every word has a fragment", "aurora* OR rollout* OR budget*", ["1", "3", "2"]],
    ["one word is shorter than three characters", 'aurora* OR rollout* OR budget* OR "ok"', ["1", "2", "3"]],
    ["one word's start matches no indexed word", "aurora* OR rollout* OR budget* OR zzqx*", ["1", "3", "2"]],
  ])("ranks by relevance when %s", async (_, query, order) => {
    const store = await opened()
    const found = await search(store, query, mode)
    expect(found.map(({ id }) => id)).toEqual(order)
    for (const { score } of found) expect(score).not.toBeNull()
  })
})
