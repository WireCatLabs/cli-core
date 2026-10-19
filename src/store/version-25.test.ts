import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("**a store from before version 25 keeps its chats** and records a re-key after the upgrade", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-25-")), "wirecat.db")
  const owner = { provider: "whatsapp", account: "1@lid" }
  const store = await openStore({ path })
  await store.chats.saveChats(owner, [
    { id: "1@s.whatsapp.net", title: "Ana", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
  ])
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 25)
  database.prepare("UPDATE chats SET title = 'Ana L'").run()
  database.close()

  const upgraded = await openStore({ path })
  await upgraded.chats.rekeyChat(owner, "1@s.whatsapp.net", "9@lid")
  expect((await upgraded.chats.chats(owner, {})).items.map((chat) => chat.title)).toEqual(["Ana L"])
  expect(await upgraded.chats.renamedChatId(owner, "1@s.whatsapp.net")).toBe("9@lid")
  await upgraded.close()
})
