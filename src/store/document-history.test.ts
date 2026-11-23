import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const DRIVE = { provider: "google-drive", account: "synthetic@example.com" }
const DAY = 24 * 60 * 60 * 1000
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const fresh = () => join(mkdtempSync(join(tmpdir(), "document-history-")), "store.db")

const setUp = async (path = fresh()) => {
  let at = Date.parse("2026-11-01T09:00:00Z")
  const store = await openStore({ path, now: () => at })
  opened.push(store)
  const account = await store.notes.documentsAccount(DRIVE, true)
  const folderId = account?.id ?? ""
  const save = (path: string, title: string, text: string, frontMatter: unknown = { kind: "page" }) =>
    store.notes.saveFileNote({ folderId, path, title, text, frontMatter, contentHash: text })
  return { store, folderId, save, tick: (ms = DAY) => (at += ms), now: () => at, path }
}

describe("a synced document's history", () => {
  it("keeps every version before an edit and before a deletion, and logs each change", async () => {
    const { store, folderId, save, tick } = await setUp()
    const { note } = await save("p1.md", "Plan", "first text")
    tick()
    await save("p1.md", "Plan", "second text")
    tick()
    await save("p1.md", "Plan for 2027", "second text")
    tick()
    expect(await store.notes.deleteFileNotes(folderId, ["p1.md"])).toBe(1)

    const history = await store.notes.documentHistory(note.ref)
    expect(history).toMatchObject({ ref: note.ref, removal: "deleted", title: "Plan for 2027" })
    expect(history.versions.map((one) => [one.revision, one.title, one.reason, one.current])).toEqual([
      [3, "Plan for 2027", "deleted", false],
      [2, "Plan", "edited", false],
      [1, "Plan", "edited", false],
    ])
    expect((await store.notes.documentVersion(note.ref, 3)).text).toBe("second text")
    expect((await store.notes.documentVersion(note.ref, 1)).text).toBe("first text")
    expect((await store.notes.documentVersion(note.ref, 1)).frontMatter).toEqual({ kind: "page" })
    await expect(store.notes.documentVersion(note.ref, 9)).rejects.toMatchObject({ code: "not_found" })

    const changes = await store.notes.documentChanges(folderId, {
      since: "2026-10-01T00:00:00Z",
      limit: 10,
      offset: 0,
    })
    expect(changes.items.map((one) => [one.event, one.title, one.path])).toEqual([
      ["deleted", "Plan for 2027", "p1.md"],
      ["changed", "Plan for 2027", "p1.md"],
      ["changed", "Plan", "p1.md"],
      ["added", "Plan", "p1.md"],
    ])
    const recent = await store.notes.documentChanges(folderId, {
      since: "2026-11-03T00:00:00Z",
      events: ["deleted", "unavailable"],
      limit: 10,
      offset: 0,
    })
    expect(recent.items.map((one) => one.event)).toEqual(["deleted"])
  })

  it("keeps the text of a document that is no longer visible, and brings it back as it was", async () => {
    const { store, folderId, save, tick } = await setUp()
    const { note } = await save("p2.md", "Shared page", "words worth keeping")
    tick()
    await store.notes.deleteFileNotes(folderId, ["p2.md"], "unavailable")
    expect(await store.notes.fileNote(folderId, "p2.md")).toBeUndefined()
    const gone = await store.notes.documentHistory(note.ref)
    expect(gone.removal).toBe("unavailable")
    expect(gone.versions).toHaveLength(1)
    expect((await store.notes.documentVersion(note.ref, gone.revision)).text).toBe("words worth keeping")

    tick()
    await save("p2.md", "Shared page", "words worth keeping")
    const back = await store.notes.documentHistory(note.ref)
    expect(back).toMatchObject({ removal: null, deletedAt: null, revision: 1 })
    const events = await store.notes.documentChanges(folderId, { since: "2026-01-01T00:00:00Z", limit: 10, offset: 0 })
    expect(events.items.map((one) => one.event)).toEqual(["restored", "unavailable", "added"])
  })

  it("does not keep a blank version when a deleted document comes back", async () => {
    const { store, folderId, save, tick } = await setUp()
    const { note } = await save("p3.md", "Draft", "old words")
    tick()
    await store.notes.deleteFileNotes(folderId, ["p3.md"])
    tick()
    await save("p3.md", "Draft", "new words")
    const history = await store.notes.documentHistory(note.ref)
    expect(history.versions.map((one) => [one.revision, one.reason, one.current, one.characters])).toEqual([
      [3, "edited", true, 9],
      [1, "deleted", false, 9],
    ])
  })

  it("drops versions, changes and an unavailable text older than the period, in that account only", async () => {
    const { store, folderId, save, tick, now } = await setUp()
    const other = await store.notes.documentsAccount({ ...DRIVE, account: "other@example.com" }, true)
    await store.notes.saveFileNote({ folderId: other?.id ?? "", path: "x.md", title: "X", text: "one" })
    await store.notes.saveFileNote({ folderId: other?.id ?? "", path: "x.md", title: "X", text: "two" })
    const { note: kept } = await save("old.md", "Old", "v1")
    await save("old.md", "Old", "v2")
    const { note: hidden } = await save("hidden.md", "Hidden", "secret plan")
    await store.notes.deleteFileNotes(folderId, ["hidden.md"], "unavailable")
    tick(400 * DAY)
    await save("old.md", "Old", "v3")

    const before = new Date(now() - 365 * DAY).toISOString()
    expect(await store.notes.pruneDocumentHistory(folderId, before)).toEqual({ versions: 1, changes: 4, texts: 1 })
    expect((await store.notes.documentHistory(kept.ref)).versions.map((one) => one.revision)).toEqual([3, 2])
    expect((await store.notes.documentHistory(hidden.ref)).versions).toEqual([])
    const left = await store.notes.documentChanges(folderId, { since: "2020-01-01T00:00:00Z", limit: 10, offset: 0 })
    expect(left.items.map((one) => one.event)).toEqual(["changed"])
    const elsewhere = await store.notes.documentChanges(other?.id ?? "", {
      since: "2020-01-01T00:00:00Z",
      limit: 10,
      offset: 0,
    })
    expect(elsewhere.items).toHaveLength(2)
  })

  it("drops an account's change log with the account", async () => {
    const { store, folderId, save, path } = await setUp()
    await save("p.md", "P", "text")
    await store.close()
    opened.splice(0)
    const database = await openCache(path)
    database.prepare("DELETE FROM files WHERE account_id = ?").run(Number(folderId))
    database.prepare("DELETE FROM documents WHERE account_id = ?").run(Number(folderId))
    database.prepare("DELETE FROM accounts WHERE id = ?").run(Number(folderId))
    expect(database.prepare("SELECT count(*) AS n FROM document_changes").get()).toEqual({ n: 0 })
    database.close()
  })
})

it("gives a version 71 file a history: its old revisions read as edits", async () => {
  const path = fresh()
  const first = await openStore({ path, now: () => Date.parse("2026-11-01T00:00:00Z") })
  const account = await first.notes.documentsAccount(DRIVE, true)
  const { note } = await first.notes.saveFileNote({
    folderId: account?.id ?? "",
    path: "a.md",
    title: "A",
    text: "one",
  })
  await first.close()

  const old = await openCache(path)
  rollBackTo(old, 72)
  expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'document_changes'").get()).toBeUndefined()
  old
    .prepare("INSERT INTO document_revisions (document_id, body, revision, created_at) VALUES (?, 'zero', 0, 0)")
    .run(Number(note.id))
  old.close()

  const upgraded = await openStore({ path })
  try {
    const history = await upgraded.notes.documentHistory(note.ref)
    expect(history.versions.map((one) => [one.revision, one.reason, one.title])).toEqual([
      [1, "edited", "A"],
      [0, "edited", null],
    ])
  } finally {
    await upgraded.close()
  }
})
