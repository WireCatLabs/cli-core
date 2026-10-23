import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openCache } from "../../store/open.js"
import { type AccountKey, type MessageStore, openStore } from "../../store/store.js"
import { stemFills as exportedFills } from "../index.js"
import { stemFills } from "./serve-stems.js"

const account: AccountKey = { provider: "test", account: "500" }
const opened: MessageStore[] = []
const withMessages = async (texts: string[]) => {
  const path = join(mkdtempSync(join(tmpdir(), "serve-stems-")), "m.db")
  const store = await openStore({ path })
  opened.push(store)
  await store.chats.saveChats(account, [
    { id: "7", title: null, kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 1 },
  ])
  await store.messages.saveMessages(
    account,
    "7",
    texts.map((text, index) => ({
      id: String(index + 1),
      chatId: "7",
      senderId: "1",
      senderName: null,
      timestamp: "2026-10-08T10:00:00.000Z",
      editedAt: null,
      text,
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    })),
    { via: "history" },
  )
  return { store, path }
}
const unfill = async (path: string, watermark: number) => {
  const database = await openCache(path)
  database.exec(
    `UPDATE search_index_state SET filled_through = 0, watermark = ${watermark} WHERE name = 'message_stems'`,
  )
  database.close()
}
const until = async (check: () => Promise<boolean>) => {
  for (let tries = 0; tries < 200 && !(await check()); tries++) await new Promise((resolve) => setTimeout(resolve, 5))
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

describe("serve's stem fill", () => {
  it("exports the scheduler through the consumer CLI entry point", () => {
    expect(exportedFills).toBe(stemFills)
  })

  it("**fills stems still building until they are ready**, then stops", async () => {
    const { store, path } = await withMessages(["houses", "casas", "квартиры"])
    await unfill(path, 3)
    expect(await store.searchIndex.stemsState()).toMatchObject({ ready: false, cause: "building" })
    const fills = stemFills({ withStore: (work) => work(store), warn: () => {}, everyMs: 1, sliceMs: 50 })
    fills.start()
    await until(async () => (await store.searchIndex.stemsState())?.ready === true)
    await fills.stop()
    expect(await store.searchIndex.stemsState()).toMatchObject({ ready: true })
    expect(fills.summary().stemmed).toBe(3)
  })

  it("**leaves stems the owner's choice made stale** for store rebuild", async () => {
    const { store } = await withMessages(["houses"])
    await store.searchIndex.saveStemmers({ cyrillic: "none", latin: "english" })
    const fills = stemFills({ withStore: (work) => work(store), warn: () => {}, everyMs: 1 })
    fills.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await fills.stop()
    expect(fills.summary().stemmed).toBe(0)
    expect(await store.searchIndex.stemsState()).toMatchObject({ ready: false, cause: "stemmer_changed" })
  })
})
