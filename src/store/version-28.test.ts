import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("**a store from before version 28 keeps its chats** and takes a chat's state after the upgrade", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-28-")), "wirecat.db")
  const owner = { provider: "whatsapp", account: "1@lid" }
  const chat = { id: "7@lid", kind: "dialog" as const }
  const store = await openStore({ path })
  await store.chats.saveChats(owner, [{ ...chat, title: "Olga", unreadCount: 2 }])
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 28)
  database.close()

  const upgraded = await openStore({ path })
  expect((await upgraded.chats.chats(owner, {})).items[0]).toMatchObject({ title: "Olga", unreadCount: 2 })
  await upgraded.chats.saveChats(owner, [{ ...chat, muted: true, archived: true, markedUnread: true }])
  expect((await upgraded.chats.chats(owner, {})).items[0]).toMatchObject({
    title: "Olga",
    unreadCount: 2,
    muted: true,
    archived: true,
    markedUnread: true,
  })
  await upgraded.close()
})
