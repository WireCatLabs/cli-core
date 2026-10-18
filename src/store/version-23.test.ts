import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("**a store from before version 23 keeps its chats** and takes chat events after the upgrade", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-23-")), "wirecat.db")
  const owner = { provider: "whatsapp", account: "1" }
  const store = await openStore({ path })
  await store.chats.saveChats(owner, [
    { id: "7", title: "Book club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 3 },
  ])
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 23)
  database.close()

  const upgraded = await openStore({ path })
  const joined = {
    messageId: "e1",
    timestamp: "2026-10-18T10:00:00.000Z",
    event: "join",
    by: { id: null, name: null },
    people: [{ id: "9", name: "Olga" }],
  }
  await upgraded.roster.saveChatEvents(owner, "7", [joined])
  expect((await upgraded.chats.chats(owner, {})).items.map((chat) => chat.title)).toEqual(["Book club"])
  expect(await upgraded.roster.chatEvents(owner, "7")).toEqual([joined])
  await upgraded.close()
})
