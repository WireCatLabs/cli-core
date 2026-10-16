import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { searchStore } from "./messages-archive-search.js"
import { embedNotes, noteTypeOfQuery, searchNotesQuery } from "./notes-search.js"

const account: AccountKey = { provider: "telegram", account: "1" }
const TEXT = "Budget review is running late. Los pisos en Valencia. Сдаю квартиру в мае."
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const message = (text: string): Message => ({
  id: "1",
  chatId: "7",
  senderId: "200",
  senderName: "alice",
  timestamp: "2026-10-01T10:00:00.000Z",
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const open = async () => {
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "notes-search-")), "store.db"),
    now: () => Date.parse("2026-10-01T10:00:00Z"),
  })
  live.push(store)
  return store
}
const noteIds = async (store: MessageStore, text: string, options: { exact?: boolean } = {}) =>
  (await searchNotesQuery(store, { text, limit: 10, timezone: "UTC", ...options })).items.map(({ note }) => note.id)

describe("a note and a message with the same text", () => {
  it.each([
    ["budget", true],
    ["run", true],
    ["piso", true],
    ["квартира", true],
    ['"budget review"', true],
    ['"review budget"', false],
    ["budg*", true],
    ["/valen.*/", true],
    ["budget AND NOT valencia", false],
    ["budget AND NOT missing", true],
    ["missing", false],
    ["exact:running", true],
    ["exact:run", false],
    ["tag:work", true],
    ["tag:other", false],
    ["date:[2026-09-01 TO 2026-10-31]", true],
    ["date:[2026-11-01 TO *]", false],
    ["body:/.*Valencia.*/", true],
    ["budget AND NOT body:/.*Valencia.*/", false],
  ])("**%s** finds both or neither (%s)", async (query, found) => {
    const store = await open()
    await store.saveChats(account, [
      { id: "7", title: "Chat 7", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.saveMessages(account, "7", [message(TEXT)], { via: "history" })
    await store.addTags(account, { type: "message", chatId: "7", messageId: "1" }, ["work"])
    const note = await store.notes.addNote({ text: TEXT })
    await store.knowledge.addTags(account, { type: "note", id: note.id }, ["work"])

    const messages = await searchStore(store, account, { text: query, limit: 10, timezone: "UTC" })
    expect(messages.items.length > 0).toBe(found)
    expect((await noteIds(store, query)).length > 0).toBe(found)
  })
})

describe("the notes' indexes", () => {
  it("**follow an edit, a deletion and a rename** of a file note", async () => {
    const store = await open()
    const folder = await store.notes.addFolder({ name: "vault" })
    const { note } = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "a.md",
      title: "Plan",
      text: "lighthouse",
    })
    expect(await noteIds(store, "lighthouse")).toEqual([note.id])
    expect(await noteIds(store, "plan")).toEqual([note.id])

    await store.notes.saveFileNote({ folderId: folder.id, path: "a.md", title: "Plan", text: "harbour" })
    expect(await noteIds(store, "lighthouse")).toEqual([])
    expect(await noteIds(store, "harbour")).toEqual([note.id])

    const moved = await store.notes.renameFileNote(folder.id, "a.md", "b.md")
    expect(moved).toMatchObject({ id: note.id, path: "b.md" })
    expect(await noteIds(store, "harbour")).toEqual([note.id])

    await store.notes.deleteFileNotes(folder.id, ["b.md"])
    expect(await noteIds(store, "harbour")).toEqual([])
    expect(await store.notes.indexState()).toMatchObject({ pending: 0, ready: true })
  })

  it("**rebuilds the stems on its own** when the stemmer choices change", async () => {
    const store = await open()
    const note = await store.notes.addNote({ text: "running" })
    expect(await noteIds(store, "run")).toEqual([note.id])
    await store.saveStemmers({ cyrillic: "russian", latin: "spanish" })
    expect(await noteIds(store, "run")).toEqual([])
    expect(await store.notes.indexState()).toMatchObject({
      built: "snowball-3.1.1 cyrillic=russian latin=spanish",
      ready: true,
    })
  })

  it("**has:text tells a read file from one kept by name only**", async () => {
    const store = await open()
    const folder = await store.notes.addFolder({ name: "drive" })
    const read = await store.notes.saveFileNote({ folderId: folder.id, path: "a.md", title: "Lease", text: "rent" })
    const named = await store.notes.saveFileNote({ folderId: folder.id, path: "b.md", title: "Lease scan", text: "" })
    expect(await noteIds(store, "lease has:text")).toEqual([read.note.id])
    expect(await noteIds(store, "lease -has:text")).toEqual([named.note.id])
    await expect(noteIds(store, "has:photo")).rejects.toMatchObject({ details: { reason: "query.unknown-value" } })
  })

  it("**title: and site: find a page by what it says about itself**", async () => {
    const store = await open()
    const folder = await store.notes.addFolder({ name: "pages" })
    const page = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "q3.html",
      title: "q3.html",
      text: "## Costs\nHosting stayed flat.",
      metadata: {
        title: "Отчёт за квартал",
        site: "Acme News",
        language: "ru-RU",
        author: "Dana Reyes",
        keywords: ["Finance"],
      },
      sections: [{ heading: "Costs", level: 2, start: 0, end: 29 }],
    })
    const other = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "b.md",
      title: "Hosting",
      text: "Hosting notes",
    })
    expect(page.note.title).toBe("Отчёт за квартал")
    expect(await noteIds(store, "title:квартал")).toEqual([page.note.id])
    expect(await noteIds(store, 'site:"acme news"')).toEqual([page.note.id])
    expect(await noteIds(store, "lang:ru author:reyes keyword:finance")).toEqual([page.note.id])
    expect(await noteIds(store, "lang:en")).toEqual([])
    expect(await noteIds(store, "hosting -site:acme")).toEqual([other.note.id])
  })

  it("refuses a message-only field, naming the note fields", async () => {
    const store = await open()
    await expect(searchNotesQuery(store, { text: "from:alice", limit: 10 })).rejects.toThrow(
      /from: is not a note field — notes take text, exact, body, tag, date, in/,
    )
  })

  it("names a missing text model by reason, not only in words", async () => {
    const store = await open()
    const env = { WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "no-model-")) }
    await expect(embedNotes(store, { env })).rejects.toMatchObject({
      code: "not_found",
      details: { reason: "model.not-downloaded", model: expect.any(String) },
    })
  })

  it("**hands out each chunk once, and finds the nearest note** by its vectors", async () => {
    const store = await open()
    const near = await store.notes.addNote({ text: "a harbour with a lighthouse" })
    const far = await store.notes.addNote({ text: "a recipe for soup" })
    const chunks = await store.notes.chunksToEmbed("test:model:2", { limit: 10 })
    expect(chunks.map(({ text }) => text).sort()).toEqual(["a harbour with a lighthouse", "a recipe for soup"])
    const unit = (x: number, y: number) => new Float32Array([x, y])
    expect(await store.notes.embedded("test:model:2", {})).toBe(false)
    await store.saveVectors(
      "test:model:2",
      2,
      chunks.map(({ hash, text }) => ({ hash, vector: text.includes("harbour") ? unit(1, 0) : unit(0, 1) })),
    )
    expect(await store.notes.chunksToEmbed("test:model:2", { limit: 10 })).toEqual([])
    expect(await store.notes.embedded("test:model:2", {})).toBe(true)
    expect(await store.notes.embedded("test:model:2", { source: "file" })).toBe(false)
    const nearest = await store.notes.nearest("test:model:2", unit(1, 0), { limit: 2 })
    expect(nearest.map(({ note, score }) => [note.id, score])).toEqual([
      [near.id, 1],
      [far.id, 0],
    ])

    await store.notes.removeNote(near.id)
    expect((await store.notes.nearest("test:model:2", unit(1, 0), { limit: 2 })).map(({ note }) => note.id)).toEqual([
      far.id,
    ])
  })

  it("cuts a page's meaning chunks at its sections, never across two", async () => {
    const store = await open()
    const folder = await store.notes.addFolder({ name: "pages" })
    const costs = `## Costs\n${"Hosting stayed flat. ".repeat(80)}`
    const text = `## Revenue\nRevenue grew.\n\n${costs}`
    await store.notes.saveFileNote({
      folderId: folder.id,
      path: "q3.html",
      title: "Report",
      text,
      sections: [
        { heading: "Revenue", level: 2, start: 0, end: text.indexOf("## Costs") },
        { heading: "Costs", level: 2, start: text.indexOf("## Costs"), end: text.length },
      ],
    })
    const chunks = (await store.notes.chunksToEmbed("test:model:2", { limit: 20 })).map(({ text }) => text)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.filter((chunk) => chunk.includes("Revenue grew") && chunk.includes("Hosting"))).toEqual([])
  })
})

describe("noteTypeOfQuery", () => {
  it("lifts a required type: out of the words the meaning half reads", () => {
    expect(noteTypeOfQuery("chapter type:internal")).toEqual({ source: "internal", rest: "chapter" })
    expect(noteTypeOfQuery("chapter AND type:FILE AND draft")).toEqual({ source: "file", rest: "chapter draft" })
    expect(noteTypeOfQuery("type:file")).toEqual({ source: "file", rest: "" })
  })

  it("leaves a type: it cannot require to the words half", () => {
    expect(noteTypeOfQuery("chapter OR type:file")).toEqual({ rest: "chapter OR type:file" })
    expect(noteTypeOfQuery("chapter -type:file")).toEqual({ rest: "chapter -type:file" })
  })
})
