import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene } from "@wirecat/cli-base/query"
import { afterEach, expect, it } from "vitest"
import { searchNotesQuery } from "../services/notes-search.js"
import type { CatalogInput } from "./sqlite/catalog.js"
import { type MessageStore, openStore } from "./store.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const setup = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "catalog-")), "store.db") })
  opened.push(store)
  const folder = await store.notes.addFolder({ name: "Synthetic source", format: "markdown" })
  return { store, account: folder.id }
}
const file = (externalId = "item.md"): CatalogInput => ({
  externalId,
  kind: "file",
  name: "Budget outline",
  parents: ["root.md"],
  mime: "text/plain",
  url: "https://example.invalid/item",
  actors: [{ id: "editor-id", name: "Rin Example", role: "editor" }],
  metadata: { version: "one" },
})
it("stores folders and unread files without inventing content and scopes reads to the chosen account", async () => {
  const { store, account } = await setup()
  const other = await store.notes.addFolder({ name: "Other" })
  await store.catalog.upsert(account, [{ ...file("root.md"), kind: "folder", parents: [] }, file()])
  const entries = await store.catalog.list(account)
  expect(entries.items).toHaveLength(2)
  expect(entries.items.every((e) => e.content === "metadata")).toBe(true)
  expect((await store.catalog.list(account, { parent: "root.md" })).items.map((e) => e.externalId)).toEqual(["item.md"])
  expect(await store.catalog.get(other.id, "item.md")).toBeUndefined()
  expect(await store.catalog.get(account, "missing.md")).toBeUndefined()
})
it("adopts indexed documents without replacing their text, revision, hash or owner tags", async () => {
  const { store, account } = await setup()
  const { note } = await store.notes.saveFileNote({
    folderId: account,
    path: "item.md",
    title: "Old",
    text: "source content",
    contentHash: "hash",
    frontMatter: { custom: "keep" },
  })
  await store.knowledge.addTags(null, { type: "document", id: note.id }, ["project"])
  await store.catalog.upsert(account, [file()])
  const entry = await store.catalog.get(account, "item.md")
  expect(entry?.ref).toBe(note.ref)
  expect(entry?.content).toBe("indexed")
  const kept = await store.notes.note(note.ref)
  expect(kept.text).toBe("source content")
  expect(kept.contentHash).toBe("hash")
  expect(kept.revision).toBe(note.revision)
  expect(kept.frontMatter).toMatchObject({ custom: "keep" })
  expect((await store.catalog.list(account, { tag: "project" })).items.map((e) => e.ref)).toEqual([note.ref])
  await store.catalog.upsert(account, [
    { ...file(), name: "Renamed", parents: ["moved.md"], metadata: { version: "two" } },
  ])
  expect((await store.catalog.get(account, "item.md"))?.ref).toBe(note.ref)
  expect((await store.catalog.list(account, { parent: "root.md" })).items).toEqual([])
  expect((await store.catalog.list(account, { parent: "moved.md" })).items).toHaveLength(1)
  expect((await store.notes.noteTags(note.ref)).map((t) => t.tag)).toContain("project")
})
it("filters metadata by name, mime, people and kind and pages consistently", async () => {
  const { store, account } = await setup()
  await store.catalog.upsert(account, [
    file("a.md"),
    { ...file("b.md"), kind: "folder", name: "Résumé archive", mime: "folder" },
    { ...file("c.md"), name: "Other", actors: [] },
  ])
  expect(
    (await store.catalog.list(account, { search: "resume", kind: "folder" })).items.map((e) => e.externalId),
  ).toEqual(["b.md"])
  expect(
    (await store.catalog.list(account, { mime: "text/plain", person: "rin" })).items.map((e) => e.externalId),
  ).toEqual(["a.md"])
  expect((await store.catalog.list(account, { person: "editor-id" })).items).toHaveLength(2)
  expect((await store.catalog.list(account, { search: "missing" })).items).toHaveLength(0)
  expect((await store.catalog.list(account, { tag: "absent" })).items).toHaveLength(0)
  expect((await store.catalog.list(account, { limit: 1 })).hasMore).toBe(true)
  expect((await store.catalog.list(account, { limit: 1, offset: 2 })).hasMore).toBe(false)
})
it("retires absent metadata while retaining its identity and annotations for re-entry", async () => {
  const { store, account } = await setup()
  await store.catalog.upsert(account, [file()])
  const before = await store.catalog.get(account, "item.md")
  expect(await store.catalog.reconcile(account, [])).toBe(1)
  expect(await store.catalog.reconcile(account, [])).toBe(0)
  expect(await store.catalog.get(account, "item.md")).toBeUndefined()
  expect((await store.catalog.list(account)).items).toEqual([])
  expect((await store.catalog.get(account, "item.md", true))?.active).toBe(false)
  expect((await store.catalog.list(account, { includeInactive: true })).items).toHaveLength(1)
  await store.catalog.upsert(account, [file()])
  expect((await store.catalog.get(account, "item.md"))?.ref).toBe(before?.ref)
  expect(await store.catalog.reconcile(account, ["item.md"])).toBe(0)
})
it("reports unreadable content separately from metadata-only entries", async () => {
  const { store, account } = await setup()
  await store.catalog.upsert(account, [file()])
  await store.notes.saveFileNote({
    folderId: account,
    path: "item.md",
    title: "Budget",
    text: "",
    frontMatter: { notRead: "unsupported type" },
  })
  expect((await store.catalog.get(account, "item.md"))?.content).toBe("unreadable")
})
it("validates whole batches before writing and rejects unknown accounts and invalid bounds", async () => {
  const { store, account } = await setup()
  await expect(store.catalog.upsert(account, [file(), { ...file("bad.md"), modifiedAt: "invalid" }])).rejects.toThrow(
    "timestamps",
  )
  expect((await store.catalog.list(account)).items).toEqual([])
  for (const entry of [
    { ...file(), externalId: "" },
    { ...file(), size: -1 },
    { ...file(), parents: [""] },
    { ...file(), name: "x".repeat(4001) },
  ])
    await expect(store.catalog.upsert(account, [entry])).rejects.toThrow("catalog")
  await expect(store.catalog.upsert(account, [file(), file()])).rejects.toThrow("repeats")
  await expect(
    store.catalog.upsert(
      account,
      Array.from({ length: 201 }, (_, i) => file(`${i}.md`)),
    ),
  ).rejects.toThrow("200")
  await expect(store.catalog.upsert(account, [{ ...file(), metadata: BigInt(1) }])).rejects.toThrow("JSON")
  await expect(store.catalog.upsert(account, [{ ...file(), metadata: "x".repeat(1000001) }])).rejects.toThrow("budget")
  await expect(store.catalog.list("unknown")).rejects.toThrow("account")
  await expect(store.catalog.list(account, { limit: 0 })).rejects.toThrow("bounds")
  await expect(store.catalog.list(account, { offset: -1 })).rejects.toThrow("bounds")
  await expect(store.catalog.reconcile(account, Array(10001).fill("x"))).rejects.toThrow("10000")
})

it("reactivates removed file metadata without claiming deleted content is indexed", async () => {
  const { store, account } = await setup()
  const { note } = await store.notes.saveFileNote({
    folderId: account,
    path: "item.md",
    title: "Old",
    text: "old source",
  })
  await store.catalog.upsert(account, [file()])
  await store.notes.deleteFileNotes(account, ["item.md"])
  expect(await store.catalog.get(account, "item.md")).toBeUndefined()
  await store.catalog.upsert(account, [file()])
  expect(await store.catalog.get(account, "item.md")).toMatchObject({ ref: note.ref, content: "metadata" })
})
it("rejects malformed runtime inputs before changing existing content", async () => {
  const { store, account } = await setup()
  for (const input of [
    { ...file(), name: null },
    { ...file(), parents: null },
    { ...file(), actors: [null] },
    { ...file(), actors: [{ email: 7 }] },
    { ...file(), modifiedAt: 7 },
  ]) {
    await expect(store.catalog.upsert(account, [input as unknown as CatalogInput])).rejects.toThrow("catalog")
  }
  expect((await store.catalog.list(account)).items).toEqual([])
})

it("preserves catalog metadata when a reader replaces extracted metadata and sections", async () => {
  const { store, account } = await setup()
  await store.catalog.upsert(account, [file()])
  await store.notes.saveFileNote({
    folderId: account,
    path: "item.md",
    title: "New",
    text: "source",
    metadata: { site: "Example" },
  })
  expect((await store.catalog.get(account, "item.md"))?.metadata).toEqual({ version: "one" })
  await store.catalog.upsert(account, [{ ...file(), name: "Another" }])
  const found = await searchNotesQuery(store, {
    text: "site:example",
    limit: 10,
    timezone: "UTC",
    folderIds: [account],
  })
  expect(found.items.map((hit) => hit.note.ref)).toEqual([(await store.catalog.get(account, "item.md"))?.ref])
})

it("compiles shared metadata queries in SQL with boolean logic, literal values and observed actors", async () => {
  const { store, account } = await setup()
  await store.catalog.upsert(account, [
    file("a.md"),
    { ...file("b.md"), name: "Résumé archive", kind: "folder", actors: [] },
  ])
  const get = async (query: string) =>
    (await store.catalog.list(account, { ast: parseLucene(query, { defaultField: "text" }) })).items.map(
      (e) => e.externalId,
    )
  expect(await get("budget AND person:Rin*")).toEqual(["a.md"])
  expect(await get('mime:"text/plain" AND NOT kind:folder')).toEqual(["a.md"])
  expect(await get("name:Resume*")).toEqual(["b.md"])
  expect(await get("name:RÉSUMÉ*")).toEqual(["b.md"])
  expect(await get('name:"résumé archive"')).toEqual(["b.md"])
  expect(await get("kind:folder OR person:editor-id")).toEqual(["a.md", "b.md"])
  expect(await get('person:"Rin Example"')).toEqual(["a.md"])
  expect(await get("parent:root.md AND text:archive")).toEqual(["b.md"])
  const ref = (await store.catalog.get(account, "a.md"))?.ref ?? ""
  await store.knowledge.addTags(null, { type: "document", id: ref.slice("document:".length) }, ["work"])
  expect(await get("tag:work")).toEqual(["a.md"])
  await expect(get("unknown:value")).rejects.toThrow()
  await expect(get("kind:invalid")).rejects.toThrow()
})

it("keeps retired catalog records out of note listings, word search and embedding preparation without deleting annotations", async () => {
  const { store, account } = await setup()
  const { note } = await store.notes.saveFileNote({
    folderId: account,
    path: "item.md",
    title: "Budget",
    text: "budget evidence",
  })
  await store.catalog.upsert(account, [file()])
  await store.knowledge.addTags(null, { type: "document", id: note.id }, ["keep"])
  expect(
    (await searchNotesQuery(store, { text: "budget", limit: 10, timezone: "UTC", folderIds: [account] })).items,
  ).toHaveLength(1)
  await store.catalog.reconcile(account, [])
  expect((await store.notes.notes({ folderId: account })).items).toHaveLength(0)
  expect(
    (await searchNotesQuery(store, { text: "budget", limit: 10, timezone: "UTC", folderIds: [account] })).items,
  ).toHaveLength(0)
  expect(await store.notes.chunksToEmbed("synthetic-model", { limit: 10 })).toHaveLength(0)
  expect((await store.notes.note(note.ref)).text).toBe("budget evidence")
  expect((await store.notes.noteTags(note.ref)).map((tag) => tag.tag)).toContain("keep")
  await store.catalog.upsert(account, [file()])
  expect(
    (await searchNotesQuery(store, { text: "budget", limit: 10, timezone: "UTC", folderIds: [account] })).items,
  ).toHaveLength(1)
})
