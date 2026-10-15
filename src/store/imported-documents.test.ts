import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene, type QueryAst } from "@wirecat/cli-base/query"
import { afterEach, expect, it } from "vitest"
import { IMPORTED_DOCUMENT_QUERY } from "./index.js"
import { type MessageStore, openStore } from "./store.js"

const telegram = { provider: "telegram", account: "500" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const setup = async () => {
  let at = Date.parse("2026-10-08T12:00:00Z")
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "imported-")), "store.db"),
    now: () => (at += 1000),
  })
  opened.push(store)
  const account = (await store.notes.addFolder({ name: "Synthetic drive" })).id
  const save = async (path: string, folderId = account) =>
    (await store.notes.saveFileNote({ folderId, path, title: path, text: `${path} body` })).note
  return { store, account, save }
}
const query = (text: string): QueryAst => parseLucene(text, { defaultField: "none" })
const paths = (page: { items: { path: string | null }[] }) => page.items.map((note) => note.path)

it("narrows by tag in the store, so a page of one still finds the last-imported tagged document", async () => {
  const { store, account, save } = await setup()
  await save("a.md")
  await save("b.md")
  const newest = await save("c.md")
  await store.knowledge.addTags(null, { type: "document", id: newest.id }, ["Budget"])
  const page = await store.notes.importedDocuments(account, query("tag:budget"), { limit: 1, offset: 0 })
  expect(paths(page)).toEqual(["c.md"])
  expect(page.hasMore).toBe(false)
  expect((await store.notes.importedDocuments(account, query("tag:other"), { limit: 1, offset: 0 })).items).toEqual([])
})

it("narrows by a linked person, by uid or person:<uid>, and finds nothing for one not known", async () => {
  const { store, account, save } = await setup()
  await store.saveAccount(telegram, { name: "Owner" })
  await store.savePeople(telegram, [{ id: "101", name: "Rin Example" }])
  const uid = (await store.personOf({ provider: "telegram", id: "101" }))?.uid
  await save("a.md")
  const linked = await save("b.md")
  await store.notes.addLink({ from: linked.ref, to: `person:${uid}`, kind: "about" })
  const page = { limit: 1, offset: 0 }
  expect(paths(await store.notes.importedDocuments(account, query(`person:${uid}`), page))).toEqual(["b.md"])
  expect(paths(await store.notes.importedDocuments(account, query(`person:"person:${uid}"`), page))).toEqual(["b.md"])
  expect((await store.notes.importedDocuments(account, query("person:nobody"), page)).items).toEqual([])
})

it("lists only this account's imported documents: no catalog-only entry, deleted, retired or foreign one", async () => {
  const { store, account, save } = await setup()
  const other = (await store.notes.addFolder({ name: "Other drive" })).id
  await save("kept.md")
  await save("gone.md")
  await save("retired.md")
  await save("foreign.md", other)
  await store.catalog.upsert(account, [
    { externalId: "root", kind: "folder", name: "Root", parents: [] },
    { externalId: "unread.pdf", kind: "file", name: "Unread", parents: ["root"] },
    { externalId: "kept.md", kind: "file", name: "Kept", parents: ["root"] },
    { externalId: "retired.md", kind: "file", name: "Retired", parents: ["root"] },
  ])
  await store.catalog.reconcile(account, ["root", "unread.pdf", "kept.md"])
  await store.notes.deleteFileNotes(account, ["gone.md"])
  const page = await store.notes.importedDocuments(account, undefined, { limit: 10, offset: 0 })
  expect(paths(page)).toEqual(["kept.md"])
})

it("refuses a field the documents list does not have", async () => {
  const { store, account } = await setup()
  expect(IMPORTED_DOCUMENT_QUERY.fields.map((field) => field.name)).toEqual(["tag", "person"])
  await expect(store.notes.importedDocuments(account, query("kind:folder"), { limit: 1, offset: 0 })).rejects.toThrow()
})
