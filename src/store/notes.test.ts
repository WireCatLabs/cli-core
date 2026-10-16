import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { MAX_TEXT_CHARS } from "../attachments/limits.js"
import { searchNotesQuery } from "../services/notes-search.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const telegram = { provider: "telegram", account: "500" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
/** An account row without the messaging writes, which this area does not own. */
const seedAccount = async (path: string, key: AccountKey) => {
  const database = await openCache(path)
  database
    .prepare("INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES (?, ?, 0, 0)")
    .run(key.provider, key.account)
  database.close()
}
const fresh = () => join(mkdtempSync(join(tmpdir(), "notes-")), "store.db")
const open = async (path: string, now = () => Date.parse("2026-10-08T12:00:00Z")) => {
  const store = await openStore({ path, now })
  opened.push(store)
  return store
}

describe("people named in notes", () => {
  const withNote = async (before: (store: MessageStore) => Promise<void> = async () => {}) => {
    const store = await open(fresh())
    await store.accounts.saveAccount(telegram, { name: "Owner" })
    await before(store)
    const folder = await store.notes.addFolder({ name: "Vault" })
    const { note } = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "meeting.md",
      title: "meeting",
      text: "With [[Rin Example]] and [[Rinny]]",
    })
    await store.notes.replaceFileLinks(note.id, [
      { kind: "links-to", targetText: "Rin Example" },
      { kind: "links-to", targetText: "@Rinny" },
    ])
    return { store, note }
  }
  const targets = async (store: MessageStore, noteId: string) =>
    (await store.notes.links({ from: `document:${noteId}` }))
      .map((link) => [link.targetText, link.to])
      .sort(([a], [b]) => String(b).localeCompare(String(a)))

  it("resolves a link the moment a person with that name appears, and not before", async () => {
    const { store, note } = await withNote()
    expect(await targets(store, note.id)).toEqual([
      ["Rin Example", null],
      ["@Rinny", null],
    ])
    await store.people.savePeople(telegram, [{ id: "101", name: "rin example" }])
    const person = await store.people.personOf({ provider: "telegram", id: "101" })
    expect(await targets(store, note.id)).toEqual([
      ["Rin Example", `person:${person?.uid}`],
      ["@Rinny", null],
    ])
  })

  it("leaves a name two people share unresolved until they are linked as one", async () => {
    const { store, note } = await withNote(async (store) => {
      await store.accounts.saveAccount({ provider: "max", account: "9" }, { name: "Owner" })
      await store.people.savePeople(telegram, [{ id: "101", name: "Rin Example" }])
      await store.people.savePeople({ provider: "max", account: "9" }, [{ id: "202", name: "Rin Example" }])
    })
    expect((await targets(store, note.id))[0]).toEqual(["Rin Example", null])
    const merged = await store.people.linkIdentities(
      { provider: "telegram", id: "101" },
      { provider: "max", id: "202" },
      { method: "manual", by: "owner" },
    )
    expect((await targets(store, note.id))[0]).toEqual(["Rin Example", `person:${merged.uid}`])
  })

  it("resolves a link by a local alias and by a username", async () => {
    const { store, note } = await withNote()
    await store.people.savePeople(telegram, [{ id: "101", name: "Somebody Else", username: "rinny" }])
    const person = await store.people.personOf({ provider: "telegram", id: "101" })
    expect((await targets(store, note.id))[1]).toEqual(["@Rinny", `person:${person?.uid}`])
    await store.people.savePeople(telegram, [{ id: "102", name: "Another Person" }])
    await store.people.setContactAlias(telegram, "102", "Rin Example")
    const aliased = await store.people.personOf({ provider: "telegram", id: "102" })
    expect((await targets(store, note.id))[0]).toEqual(["Rin Example", `person:${aliased?.uid}`])
  })
})

describe("the notes store", () => {
  it("keeps a file note's earlier text, tags it, and drops its tags when the file goes", async () => {
    const path = fresh()
    const store = await open(path)
    await seedAccount(path, telegram)
    const folder = await store.notes.addFolder({ name: "Vault", format: "markdown" })
    const input = { folderId: folder.id, path: "a.md", title: "a", text: "One", contentHash: "h1" }
    const { note } = await store.notes.saveFileNote(input)
    expect((await store.notes.saveFileNote(input)).changed).toBe(false)
    const edited = await store.notes.saveFileNote({ ...input, text: "Two", contentHash: "h2" })
    expect(edited).toMatchObject({ changed: true, note: { id: note.id, revision: 2, text: "Two" } })
    expect(await store.knowledge.addTags(telegram, { type: "document", id: note.id }, ["Work"])).toEqual(["work"])
    expect(await store.notes.deleteFileNotes(folder.id, ["a.md"])).toBe(1)
    expect(await store.knowledge.tags(telegram, { type: "document", id: note.id })).toEqual([])
    expect(await store.notes.note(note.ref)).toMatchObject({ text: "", deletedAt: expect.any(String) })
    await expect(store.notes.removeNote(note.ref)).rejects.toMatchObject({ code: "validation_error" })
  })

  it("writes internal notes about anything, guards stale edits, and keeps the owner's links on re-import", async () => {
    const store = await open(fresh())
    const project = await store.knowledge.addProject({ name: "Lighthouse" })
    const note = await store.notes.addNote({ text: "Budget is tight", about: [project.ref] })
    expect((await store.notes.notes({ about: project.ref })).items.map((one) => one.ref)).toEqual([note.ref])
    expect(await store.notes.editNote(note.id, "Budget is fine", 1)).toMatchObject({ revision: 2 })
    await expect(store.notes.editNote(note.id, "Stale", 1)).rejects.toMatchObject({ code: "validation_error" })

    const folder = await store.notes.addFolder({ name: "Vault" })
    const { note: file } = await store.notes.saveFileNote({ folderId: folder.id, path: "x.md", title: "x", text: "x" })
    const owner = await store.notes.addLink({ from: file.ref, to: project.ref, kind: "about" })
    await store.notes.replaceFileLinks(file.id, [{ kind: "links-to", to: note.ref, anchor: "#Budget" }])
    await store.notes.replaceFileLinks(file.id, [{ kind: "links-to", to: note.ref }])
    expect((await store.notes.links({ from: file.ref })).map((link) => [link.origin, link.anchor]).sort()).toEqual([
      ["file", null],
      ["owner", null],
    ])
    await store.notes.removeLink(owner.id)
    await store.notes.removeNote(note.id)
    await expect(store.notes.note(note.ref)).rejects.toMatchObject({ code: "not_found" })
    expect(await store.notes.links({ from: note.ref })).toEqual([])
    await expect(store.notes.addLink({ from: "nothing", to: "note:1", kind: "about" })).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(store.notes.addLink({ from: "note:01J", to: project.ref, kind: "about" })).rejects.toMatchObject({
      code: "not_found",
    })
    await expect(store.notes.addLink({ from: file.ref, kind: "about" })).rejects.toMatchObject({
      code: "validation_error",
    })
  })
})

describe("people named in notes, over rows written directly", () => {
  it("resolves a written name to the one person holding it, and leaves a shared name open", async () => {
    const path = fresh()
    const store = await open(path)
    const folder = await store.notes.addFolder({ name: "Vault" })
    const { note } = await store.notes.saveFileNote({ folderId: folder.id, path: "m.md", title: "m", text: "m" })
    await store.notes.replaceFileLinks(note.id, [
      { kind: "links-to", targetText: "Rin Example" },
      { kind: "links-to", targetText: "@Bob Sample" },
    ])
    const database = await openCache(path)
    database.exec(`INSERT INTO persons (id, name, created_at, updated_at) VALUES (11, 'Rin', 0, 0), (12, 'Bob', 0, 0), (13, 'Bob', 0, 0);
      INSERT INTO identities (id, provider, external_id, name, created_at, updated_at) VALUES
        (1, 'telegram', '101', 'Rin Example', 0, 0), (2, 'telegram', '102', 'Bob Sample', 0, 0), (3, 'max', '9', 'Bob Sample', 0, 0);
      INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, updated_at) VALUES
        (1, 11, 'initial', 1, 0, 'ingest', 0), (2, 12, 'initial', 1, 0, 'ingest', 0), (3, 13, 'initial', 1, 0, 'ingest', 0)`)
    database.close()

    expect(await store.notes.resolveLinks()).toBe(1)
    expect((await store.notes.links({ from: note.ref })).map((link) => [link.targetText, link.to]).sort()).toEqual([
      ["@Bob Sample", null],
      ["Rin Example", "person:11"],
    ])
  })
})

describe("file note length", () => {
  it("keeps as much text as the document readers return, and finds a word at its end", async () => {
    const store = await open(fresh())
    const folder = await store.notes.addFolder({ name: "Drive" })
    const text = `${"аренда кровати ".repeat(Math.floor((MAX_TEXT_CHARS - 20) / 15))}lastneedle`
    const { note } = await store.notes.saveFileNote({ folderId: folder.id, path: "core.md", title: "core", text })
    expect((await store.notes.note(note.ref)).text).toHaveLength(text.length)
    expect(
      (await searchNotesQuery(store, { text: "lastneedle", limit: 5, exact: true })).items.map((hit) => hit.ref),
    ).toContain(note.ref)
    await expect(
      store.notes.saveFileNote({
        folderId: folder.id,
        path: "over.md",
        title: "over",
        text: "x".repeat(MAX_TEXT_CHARS + 1),
      }),
    ).rejects.toThrow(`0–${MAX_TEXT_CHARS} characters`)
  })
})
