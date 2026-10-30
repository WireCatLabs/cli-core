import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { drainNoteIndex } from "./sqlite/note-index.js"
import { stemmerCache } from "./sqlite/stems.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "max", account: "1" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const fresh = () => join(mkdtempSync(join(tmpdir(), "version-40-")), "wirecat.db")

const open = async (path: string) => {
  const store = await openStore({ path })
  opened.push(store)
  return store
}

const drain = async (path: string) => {
  const database = await openCache(path)
  drainNoteIndex(database, stemmerCache())
  database.close()
}

/** Vera has a dialog with the owner, so she is a contact. */
const withContact = async (path: string) => {
  const store = await open(path)
  await store.people.savePeople(OWNER, [
    { id: "1", name: "Owner" },
    { id: "7", name: "Vera" },
  ])
  await store.chats.saveChats(OWNER, [
    { id: "d7", title: null, kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.roster.saveMembers(OWNER, "d7", ["1", "7"])
  return store
}

const noteTexts = async (store: MessageStore, search: string) =>
  (await store.notes.notes({ search })).items.map(({ text }) => text).sort()

it("**finds notes, documents, annotations and contacts by any part of a word**, in any letter case and ё as е", async () => {
  const path = fresh()
  const store = await withContact(path)
  await store.notes.addNote({ text: "Встреча в ТАРТУСЕ завтра" })
  await store.notes.addNote({ text: "the KUBERNETES cluster" })
  const folder = await store.notes.addFolder({ name: "Vault" })
  await store.notes.saveFileNote({
    folderId: folder.id,
    path: "a.md",
    title: "a",
    text: "Пётр Ёлкин",
    contentHash: "h",
  })
  await store.people.addContactNote(OWNER, "7", "Переподстроение системы")
  await drain(path)

  expect(await noteTexts(store, "тартус")).toEqual(["Встреча в ТАРТУСЕ завтра"])
  expect(await noteTexts(store, "bernet")).toEqual(["the KUBERNETES cluster"])
  expect(await noteTexts(store, "елкин")).toEqual(["Пётр Ёлкин"])
  expect(await noteTexts(store, "ПЁТР ЁЛ")).toEqual(["Пётр Ёлкин"])
  const annotations = await store.knowledge.annotations(OWNER, { search: "ПОДСТРО" })
  expect(annotations.items.map(({ text }) => text)).toEqual(["Переподстроение системы"])
  const contacts = await store.people.contacts(OWNER, { order: "name", notes: "подстро", limit: 10 })
  expect(contacts.items.map(({ id }) => id)).toEqual(["7"])
})

it("**refuses a query of one or two characters**, as message search does", async () => {
  const store = await withContact(fresh())
  const refused = { code: "validation_error", message: "search needs at least three characters" }
  await expect(store.notes.notes({ search: "ян" })).rejects.toMatchObject(refused)
  await expect(store.knowledge.annotations(OWNER, { search: " я " })).rejects.toMatchObject(refused)
  await expect(store.people.contacts(OWNER, { order: "name", notes: "ab", limit: 10 })).rejects.toMatchObject(refused)
})

it("**forgets the old text of an edited note and every text of a removed one**", async () => {
  const path = fresh()
  const store = await open(path)
  const kept = await store.notes.addNote({ text: "Тартусский договор" })
  const removed = await store.notes.addNote({ text: "Тартусская встреча" })
  await drain(path)
  await store.notes.editNote(kept.id, "Договор аренды", 1)
  await store.notes.removeNote(removed.ref)
  await drain(path)

  expect(await noteTexts(store, "ТАРТУС")).toEqual([])
  expect(await noteTexts(store, "АРЕНД")).toEqual(["Договор аренды"])
  const database = await openCache(path)
  expect(database.prepare("SELECT count(*) AS n FROM note_trigrams").get()?.n).toBe(1)
  database.close()
})

it("**indexes notes and documents stored before version 40**, and finds them meanwhile by their text", async () => {
  const path = fresh()
  const store = await open(path)
  await store.notes.addNote({ text: "Встреча в ТАРТУСЕ" })
  const folder = await store.notes.addFolder({ name: "Vault" })
  await store.notes.saveFileNote({
    folderId: folder.id,
    path: "a.md",
    title: "a",
    text: "KUBERNETES",
    contentHash: "h",
  })
  await drain(path)
  await store.close()
  opened.splice(0)
  const old = await openCache(path)
  rollBackTo(old, 40)
  old.close()

  const upgraded = await open(path)
  expect(await noteTexts(upgraded, "bernet")).toEqual(["KUBERNETES"])
  expect(await noteTexts(upgraded, "тартус")).toEqual([])
  await drain(path)
  expect(await noteTexts(upgraded, "тартус")).toEqual(["Встреча в ТАРТУСЕ"])
  expect(await noteTexts(upgraded, "bernet")).toEqual(["KUBERNETES"])
})
