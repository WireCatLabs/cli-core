import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene } from "@wirecat/cli-base/query"
import { afterEach, expect, it } from "vitest"
import type { ServiceDeps } from "../services/deps.js"
import { tagsService } from "../services/tags.js"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const account: AccountKey = { provider: "telegram", account: "100" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const freshPath = () => join(mkdtempSync(join(tmpdir(), "case-fold-")), "wirecat.db")

const tagged = async (path: string) => {
  const store = await openStore({ path })
  opened.push(store)
  await store.chats.saveChats(account, [
    { id: "1", title: "ПЛАНЁРКА Team", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.people.savePeople(account, [{ id: "101", name: "Анна Example" }])
  await store.knowledge.addTags(account, { type: "chat", id: "1" }, ["work"])
  await store.knowledge.addTags(account, { type: "contact", id: "101" }, ["work"])
  return store
}

const namesFor = async (store: MessageStore, text: string) => {
  const service = tagsService({ store: async () => store, account: async () => account } as ServiceDeps)
  const { items } = await service.list({ query: parseLucene(text), limit: 10, offset: 0 })
  return items.map((item) => item.name)
}

const folded = async (path: string, sql: string) => {
  const database = await openCache(path)
  try {
    return database.prepare(sql).all()
  } finally {
    database.close()
  }
}

it("tags list name: matches chat titles and contact names in any case and script", async () => {
  const store = await tagged(freshPath())
  expect(await namesFor(store, "name:*планерка*")).toEqual(["ПЛАНЁРКА Team"])
  expect(await namesFor(store, "name:*TEAM*")).toEqual(["ПЛАНЁРКА Team"])
  expect(await namesFor(store, 'name:"АННА EXAMPLE"')).toEqual(["Анна Example"])
})

it("a rename by a build that does not know the copy empties it, and the next open refills it", async () => {
  const path = freshPath()
  await (await tagged(path)).close()
  opened.splice(0)
  const old = await openCache(path)
  try {
    old.exec("UPDATE chats SET title = 'Ежедневный СОЗВОН'")
    old.exec("UPDATE identities SET name = 'Борис Example'")
  } finally {
    old.close()
  }
  expect(
    await folded(path, "SELECT title_folded AS v FROM chats UNION ALL SELECT name_folded FROM identities"),
  ).toEqual([{ v: null }, { v: null }])

  const store = await openStore({ path })
  opened.push(store)
  expect(await namesFor(store, "name:*созвон*")).toEqual(["Ежедневный СОЗВОН"])
  expect(await namesFor(store, "name:*БОРИС*")).toEqual(["Борис Example"])
})

it("version 38 fills the folded copies of names stored before it", async () => {
  const path = freshPath()
  const store = await tagged(path)
  await store.knowledge.addProject({ key: "TRT", name: "Тартус", scope: "work" })
  await store.close()
  opened.splice(0)
  const old = await openCache(path)
  rollBackTo(old, 38)
  old.close()

  opened.push(await openStore({ path }))
  expect(
    await folded(
      path,
      `SELECT name_folded AS v FROM projects WHERE key = 'TRT'
       UNION ALL SELECT title_folded FROM chats UNION ALL SELECT name_folded FROM identities`,
    ),
  ).toEqual([{ v: "тартус" }, { v: "планерка team" }, { v: "анна example" }])
})
