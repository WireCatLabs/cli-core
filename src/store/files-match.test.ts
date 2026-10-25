import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const setup = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "files-match-")), "store.db")
  const store = await openStore({ path })
  opened.push(store)
  const sql = async (query: string) => {
    const database = await openCache(path)
    try {
      return database.prepare(query).all()
    } finally {
      database.close()
    }
  }
  const work = await store.notes.addFolder({ name: "Work" })
  const home = await store.notes.addFolder({ name: "Home", format: "markdown" })
  const save = (folderId: string, path: string, text: string) =>
    store.notes.saveFileNote({ folderId, path, title: null, text, contentHash: `hash:${text}` })
  const listed = async (folderId: string) =>
    (await store.notes.notes({ folderId, source: "file" })).items.map(({ id, path }) => [id, path])
  return { store, sql, work: work.id, home: home.id, save, listed }
}

describe("a file with the content of one document (rule 2)", () => {
  it("is a copy of it: one document, a file in each folder, each folder listing it under its own path", async () => {
    const { store, work, home, save, listed } = await setup()
    const { note } = await save(work, "plans/q4.md", "Quarter plan")
    const { note: copy } = await save(home, "q4-copy.md", "Quarter plan")
    expect(copy.ref).toBe(note.ref)
    expect(copy.path).toBe("q4-copy.md")
    expect(await listed(work)).toEqual([[note.id, "plans/q4.md"]])
    expect(await listed(home)).toEqual([[note.id, "q4-copy.md"]])
    expect((await store.files.ofDocument(note.ref)).map(({ path }) => path).sort()).toEqual([
      "plans/q4.md",
      "q4-copy.md",
    ])
  })

  it("moved to another folder stays the same document when the new folder syncs first", async () => {
    const { store, work, home, save, listed } = await setup()
    const { note } = await save(work, "spec.md", "The spec")
    await store.knowledge.addTags(null, { type: "document", id: note.id }, ["kept-tag"])
    const { note: moved } = await save(home, "spec.md", "The spec")
    await store.notes.deleteFileNotes(work, ["spec.md"])
    expect(moved.ref).toBe(note.ref)
    expect((await store.notes.note(note.ref)).deletedAt).toBeNull()
    expect(await listed(work)).toEqual([])
    expect(await listed(home)).toEqual([[note.id, "spec.md"]])
    expect((await store.notes.noteTags(note.ref)).map(({ tag }) => tag)).toContain("kept-tag")
  })

  it("moved to another folder stays the same document, with its tags, when the old folder syncs first", async () => {
    const { store, work, home, save, listed, sql } = await setup()
    const { note } = await save(work, "spec.md", "The spec")
    await store.knowledge.addTags(null, { type: "document", id: note.id }, ["kept-tag"])
    await store.notes.addLink({ from: note.ref, targetText: "Example Person", kind: "links-to" })
    await store.notes.deleteFileNotes(work, ["spec.md"])
    expect((await store.notes.note(note.ref)).deletedAt).not.toBeNull()
    const { note: moved } = await save(home, "spec.md", "The spec")
    expect(moved.ref).toBe(note.ref)
    expect((await store.notes.note(note.ref)).deletedAt).toBeNull()
    expect((await store.notes.note(note.ref)).text).toBe("The spec")
    expect(await listed(home)).toEqual([[note.id, "spec.md"]])
    expect(await store.notes.links({ from: note.ref })).toHaveLength(1)
    expect((await store.notes.noteTags(note.ref)).map(({ tag }) => tag)).toEqual(["kept-tag"])
    expect((await store.knowledge.labelled(null, { tag: "kept-tag" })).items).toHaveLength(1)
    expect(await sql("SELECT count(*) AS n FROM documents")).toEqual([{ n: 1 }])
  })

  it("renamed and edited in one sync is a new document; the old one is kept as deleted, never re-inserted", async () => {
    const { store, work, save, listed, sql } = await setup()
    const { note } = await save(work, "draft.md", "First words")
    await save(work, "final.md", "First words, edited")
    await store.notes.deleteFileNotes(work, ["draft.md"])
    const [[id, path]] = (await listed(work)) as [[string, string]]
    expect(path).toBe("final.md")
    expect(id).not.toBe(note.id)
    const old = await store.notes.note(note.ref)
    expect(old.id).toBe(note.id)
    expect(old.deletedAt).not.toBeNull()
    expect(await sql("SELECT id FROM documents ORDER BY id")).toEqual([{ id: Number(note.id) }, { id: Number(id) }])
  })

  it("renamed alone keeps its document and file row; a rename then an edit too", async () => {
    const { store, work, save, sql } = await setup()
    const { note } = await save(work, "a.md", "Text")
    const [before] = (await sql("SELECT id FROM files WHERE kind = 'file'")) as [{ id: number }]
    await store.notes.renameFileNote(work, "a.md", "b.md")
    const { note: edited } = await save(work, "b.md", "Text, edited")
    expect(edited.ref).toBe(note.ref)
    expect(await sql("SELECT id, path FROM files WHERE kind = 'file'")).toEqual([{ id: before.id, path: "b.md" }])
  })

  it("with two documents of that content links to neither: a new document, and one review entry", async () => {
    const { store, work, home, save, sql } = await setup()
    const third = await store.notes.addFolder({ name: "Third" })
    const { note: one } = await save(work, "a.md", "One")
    const { note: two } = await save(home, "b.md", "Two")
    await save(work, "a.md", "Same")
    await save(home, "b.md", "Same")
    const { note: fresh } = await save(third.id, "c.md", "Same")
    expect([one.id, two.id]).not.toContain(fresh.id)
    expect(await sql("SELECT linkable_type, entity_type, candidates, reason, status FROM link_reviews")).toEqual([
      {
        linkable_type: "file",
        entity_type: "document",
        candidates: JSON.stringify([Number(one.id), Number(two.id)]),
        reason: "content-hash",
        status: "open",
      },
    ])
  })

  it("never joins by empty text", async () => {
    const { work, home, save } = await setup()
    const { note } = await save(work, "a.md", "")
    const { note: other } = await save(home, "b.md", "")
    expect(other.id).not.toBe(note.id)
  })

  it("on disk joins a Drive document without touching Drive's front matter or where Drive keeps it", async () => {
    const { store, home, sql } = await setup()
    const drive = await store.notes.addFolder({ name: "google-drive:owner-1", format: "markdown" })
    const frontMatter = { source: "google-drive", fileId: "file-1", sourceUrl: "https://docs.google.com/document/d/x" }
    const { note } = await store.notes.saveFileNote({
      folderId: drive.id,
      path: "file-1.md",
      title: "Plan",
      text: "Exported plan",
      frontMatter,
      contentHash: "drive-hash",
    })
    const { note: copy } = await store.notes.saveFileNote({
      folderId: home,
      path: "Plan.md",
      title: "Plan",
      text: "Exported plan",
      frontMatter: { tags: ["local"] },
      contentHash: "drive-hash",
    })
    expect(copy.ref).toBe(note.ref)
    const stored = await store.notes.note(note.ref)
    expect(stored.frontMatter).toEqual(frontMatter)
    expect(stored.folderId).toBe(drive.id)
    expect(await sql(`SELECT metadata FROM files WHERE account_id = ${home}`)).toEqual([
      { metadata: '{"front_matter":{"tags":["local"]}}' },
    ])
  })

  it("shows the file the owner pinned, wherever the latest change was", async () => {
    const { store, work, home, save, sql } = await setup()
    const { note } = await save(work, "a.md", "Shared")
    await save(home, "a.md", "Shared")
    const pinned = (await store.files.ofDocument(note.ref)).find(({ accountId }) => accountId === work)
    await store.files.pin(note.ref, pinned?.id as string)
    await save(home, "a.md", "Shared, edited at home")
    expect((await store.files.ofDocument(note.ref))[0]?.id).toBe(pinned?.id)
    expect(await sql(`SELECT account_id FROM documents WHERE id = ${note.id}`)).toEqual([{ account_id: Number(work) }])
  })
})

it("moves a file the owner reviewed to the document they chose; the one made while it waited goes", async () => {
  const { store, work, home, save, listed } = await setup()
  const third = await store.notes.addFolder({ name: "Third" })
  const { note: one } = await save(work, "a.md", "One")
  await save(home, "b.md", "Two")
  await save(work, "a.md", "Same")
  await save(home, "b.md", "Same")
  const { note: made } = await save(third.id, "c.md", "Same")
  const [review] = await store.calendar.reviews({ status: "open" })
  await store.calendar.resolveReview(review?.id as number, { choose: Number(one.id) }, 10)
  expect(await listed(third.id)).toEqual([[one.id, "c.md"]])
  expect((await store.notes.note(made.ref)).deletedAt).not.toBeNull()
})
