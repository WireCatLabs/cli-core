import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("**a store from before version 24 keeps its messages** and takes the owner's stars after the upgrade", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-24-")), "wirecat.db")
  const owner = { provider: "whatsapp", account: "1" }
  const store = await openStore({ path })
  await store.chats.saveChats(owner, [
    { id: "7", title: "Book club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 3 },
  ])
  await store.messages.saveMessages(
    owner,
    "7",
    [
      {
        id: "1",
        chatId: "7",
        senderId: "9",
        senderName: "Olga",
        timestamp: "2026-10-18T10:00:00.000Z",
        editedAt: null,
        text: "the venue changed",
        outgoing: false,
        attachments: [],
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
      },
    ],
    { via: "history" },
  )
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 24)
  database.close()

  const upgraded = await openStore({ path })
  expect((await upgraded.messages.messages(owner, "7", { limit: 5 })).items.map((one) => one.text)).toEqual([
    "the venue changed",
  ])
  expect(await upgraded.messages.saveStar(owner, "7", "1", true)).toBe(true)
  expect((await upgraded.messages.messages(owner, "7", { limit: 5, starred: true })).items[0]?.starred).toBe(true)
  await upgraded.close()
})
