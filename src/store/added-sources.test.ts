import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { searchNotesQuery } from "../services/notes-search.js"
import { searchAll } from "../services/search-all.js"
import { previewDocumentTransfer } from "./document-transfer/index.js"
import { openCache } from "./open.js"
import { addedSourceKeyOf } from "./sqlite/added-sources.js"
import { type MessageStore, openStore } from "./store.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")

const setup = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "added-sources-")), "store.db")
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
  const project = await store.knowledge.addProject({ name: "Lighthouse" })
  const other = await store.knowledge.addProject({ name: "Harbour" })
  return { store, sql, lighthouse: `project:${project.id}`, harbour: `project:${other.id}` }
}

const pdf = new TextEncoder().encode("%PDF-1.4 synthetic runner notes")
const file = {
  kind: "file",
  bytes: pdf,
  read: "extracted",
  text: "Runner notes: quinoaplan for the relay",
  by: "owner",
} as const

describe("a source added by hand", () => {
  it("is saved once: a repeat import is the same document, linked to the new subjects only", async () => {
    const { store, sql, lighthouse, harbour } = await setup()
    const first = await store.notes.saveAddedSource({ ...file, title: "Runner notes", subjects: [lighthouse] })
    expect(first).toMatchObject({ created: true, duplicateOf: null, kept: "text", subjects: [lighthouse] })
    expect(first.note.path).toBe(`sha256:${sha(pdf)}`)
    const again = await store.notes.saveAddedSource({ ...file, subjects: [lighthouse, harbour] })
    expect(again).toMatchObject({ created: false, duplicateOf: null, kept: "text", subjects: [lighthouse, harbour] })
    expect(again.note.ref).toBe(first.note.ref)
    expect(await sql("SELECT count(*) AS n FROM documents")).toEqual([{ n: 1 }])
    expect(
      await sql(
        "SELECT count(*) AS n FROM links WHERE from_type = 'document' AND kind = 'about' AND to_type = 'project'",
      ),
    ).toEqual([{ n: 2 }])
    expect(await store.notes.addedAccount()).toMatchObject({ provider: "added", name: "added:owner" })
  })

  it("links an agent's subjects unconfirmed, as its proposal", async () => {
    const { store, lighthouse } = await setup()
    const by = { bot: "memo-agent", reason: "the notes name the relay project" }
    const { note, subjects } = await store.notes.saveAddedSource({ ...file, by, subjects: [lighthouse] })
    expect(subjects).toEqual([lighthouse])
    expect(await store.notes.links({ from: note.ref })).toEqual([
      expect.objectContaining({ kind: "about", origin: "suggested", confirmed: false }),
    ])
  })

  it("keeps only the text unless a copy is asked for, and says so", async () => {
    const { store, sql } = await setup()
    const text = await store.notes.saveAddedSource(file)
    expect(text.kept).toBe("text")
    const copy = await store.notes.saveAddedSource({ ...file, keepCopy: { path: "/var/tmp/copies/runner.pdf" } })
    expect(copy).toMatchObject({ created: false, kept: "copy" })
    expect(await sql("SELECT storage, local_path FROM documents")).toEqual([
      { storage: "copy", local_path: "/var/tmp/copies/runner.pdf" },
    ])
    const pasted = await store.notes.saveAddedSource({
      by: "owner",
      kind: "text",
      read: "extracted",
      text: "A pasted line",
    })
    expect(pasted.kept).toBe("text")
    await expect(
      store.notes.saveAddedSource({
        by: "owner",
        kind: "text",
        read: "extracted",
        text: "x",
        keepCopy: { path: "/var/tmp/x" },
      }),
    ).rejects.toMatchObject({ code: "validation_error" })
  })

  it("names pasted text and a page by their normalized text, so spacing does not make a second source", async () => {
    const { store } = await setup()
    const one = await store.notes.saveAddedSource({
      by: "owner",
      kind: "text",
      read: "extracted",
      text: "Call  Kai\non Friday",
    })
    const two = await store.notes.saveAddedSource({
      by: "owner",
      kind: "text",
      read: "extracted",
      text: " Call Kai on Friday ",
    })
    expect(two).toMatchObject({ created: false })
    expect(two.note.ref).toBe(one.note.ref)
    expect(one.note.path).toBe(`sha256:${sha("Call Kai on Friday")}`)
    const page = await store.notes.saveAddedSource({
      by: "owner",
      kind: "page",
      read: "no-text",
      text: "",
      url: "https://example.com/photo",
      title: "Whiteboard",
    })
    expect(page.note.path).toBe(`sha256:${sha("https://example.com/photo")}`)
  })

  it("answers a live folder document of the same file as duplicate_of, adding only the subjects", async () => {
    const { store, sql, lighthouse } = await setup()
    const folder = await store.notes.addFolder({ name: "Work" })
    const { note } = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "runner.pdf",
      title: null,
      text: "Runner notes",
      contentHash: sha(pdf),
    })
    const added = await store.notes.saveAddedSource({ ...file, subjects: [lighthouse] })
    expect(added).toMatchObject({ created: false, duplicateOf: note.ref, kept: null, subjects: [lighthouse] })
    expect(await sql("SELECT count(*) AS n FROM documents")).toEqual([{ n: 1 }])
  })

  it("answers pasted text equal to a Drive document's text as duplicate_of it", async () => {
    const { store } = await setup()
    const drive = await store.notes.documentsAccount({ provider: "google-drive", account: "u1" }, true)
    const text = "Quarter plan\n\nShip the relay\n"
    const { note } = await store.notes.saveFileNote({
      folderId: drive?.id as string,
      path: "doc-1.md",
      title: "Quarter plan",
      text,
      contentHash: sha(text),
      frontMatter: { source: "google-drive" },
    })
    expect(await store.notes.saveAddedSource({ by: "owner", kind: "text", read: "extracted", text })).toMatchObject({
      duplicateOf: note.ref,
    })
  })

  it("is not joined by a folder file of the same content, so the file's removal cannot delete it", async () => {
    const { store, sql } = await setup()
    const added = await store.notes.saveAddedSource(file)
    const folder = await store.notes.addFolder({ name: "Work", format: "markdown" })
    const input = { folderId: folder.id, path: "runner.pdf", title: null, text: file.text, contentHash: sha(pdf) }
    const { note } = await store.notes.saveFileNote(input)
    expect(note.ref).not.toBe(added.note.ref)
    await store.notes.deleteFileNotes(folder.id, ["runner.pdf"])
    expect((await store.notes.note(added.note.ref)).deletedAt).toBeNull()
    const account = await store.notes.addedAccount()
    await expect(store.notes.deleteFileNotes(account?.id as string, [added.note.path as string])).rejects.toMatchObject(
      { code: "validation_error" },
    )
    expect(await sql("SELECT count(*) AS n FROM documents WHERE deleted_at IS NULL")).toEqual([{ n: 1 }])
  })

  it("is saved anew once the folder document it duplicated is gone, and revived after its own removal", async () => {
    const { store } = await setup()
    const folder = await store.notes.addFolder({ name: "Work", format: "markdown" })
    await store.notes.saveFileNote({
      folderId: folder.id,
      path: "a.pdf",
      title: null,
      text: "x",
      contentHash: sha(pdf),
    })
    expect((await store.notes.saveAddedSource(file)).duplicateOf).not.toBeNull()
    await store.notes.deleteFileNotes(folder.id, ["a.pdf"])
    const own = await store.notes.saveAddedSource(file)
    expect(own).toMatchObject({ created: true, duplicateOf: null })
    await store.notes.removeAddedSource(own.note.ref, "owner")
    const revived = await store.notes.saveAddedSource(file)
    expect(revived).toMatchObject({ created: false, duplicateOf: null })
    expect(revived.note).toMatchObject({ ref: own.note.ref, deletedAt: null, text: file.text })
    expect((await searchNotesQuery(store, { text: "quinoaplan", limit: 5 })).items.map(({ ref }) => ref)).toEqual([
      own.note.ref,
    ])
  })

  it("is found by notes search, gets pieces for meaning search, and search all reads its account", async () => {
    const { store, sql } = await setup()
    const { note } = await store.notes.saveAddedSource({ ...file, title: "Runner notes" })
    const image = await store.notes.saveAddedSource({
      by: "owner",
      kind: "file",
      bytes: new Uint8Array([1, 2, 3]),
      read: "no-text",
      text: "",
      title: "Whiteboard zebrasketch",
      mime: "image/png",
    })
    expect((await searchNotesQuery(store, { text: "quinoaplan", limit: 5 })).items.map(({ ref }) => ref)).toEqual([
      note.ref,
    ])
    expect((await searchNotesQuery(store, { text: "zebrasketch", limit: 5 })).items.map(({ ref }) => ref)).toEqual([
      image.note.ref,
    ])
    expect(
      await sql(`SELECT count(*) AS n FROM chunks WHERE chunkable_type = 'document' AND chunkable_id = ${note.id}`),
    ).toEqual([{ n: 1 }])
    const found = await searchAll(
      store,
      { provider: "synthetic", account: "1" },
      { text: "quinoaplan", limit: 5, only: ["notes"] },
    )
    expect(found.items.map(({ ref }) => ref)).toEqual([note.ref])
    const account = await store.notes.addedAccount()
    expect(found.accounts).toContainEqual({ resource: "notes", provider: "notes", account: account?.id })
  })

  it("reads back what a source is and what was kept of it, and nothing for another document", async () => {
    const { store } = await setup()
    const saved = await store.notes.saveAddedSource({
      ...file,
      fileName: "runner-notes.pdf",
      mime: "application/pdf",
      keepCopy: { path: "/copies/abc" },
    })
    expect(await store.notes.addedSource(saved.note.ref)).toEqual({
      note: saved.note,
      kind: "file",
      url: null,
      fileName: "runner-notes.pdf",
      mime: "application/pdf",
      size: pdf.byteLength,
      kept: "copy",
      copy: "/copies/abc",
    })
    const page = await store.notes.saveAddedSource({
      kind: "page",
      read: "extracted",
      text: "A public page",
      url: "https://example.org/a",
      mime: "text/html",
      size: 120,
      by: "owner",
    })
    expect(await store.notes.addedSource(page.note.ref)).toMatchObject({
      kind: "page",
      url: "https://example.org/a",
      size: 120,
      kept: "text",
      copy: null,
    })
    const note = await store.notes.addNote({ text: "A note of the owner's" })
    expect(await store.notes.addedSource(note.ref)).toBeUndefined()
    expect(await store.notes.addedSource("document:999")).toBeUndefined()
    await store.notes.removeAddedSource(page.note.ref, "owner")
    expect(await store.notes.addedSource(page.note.ref)).toBeUndefined()
  })

  it("refuses what it cannot name or would misstate", async () => {
    const { store } = await setup()
    const refused = [
      { kind: "file", read: "extracted", text: "no bytes" },
      { kind: "text", read: "no-text", text: "" },
      { kind: "page", read: "extracted", text: "no address" },
      { kind: "file", bytes: pdf, read: "no-text", text: "but text" },
      { kind: "file", bytes: pdf, read: "extracted", text: "x", subjects: ["project:999"] },
    ] as const
    for (const input of refused)
      await expect(store.notes.saveAddedSource({ ...input, by: "owner" })).rejects.toMatchObject({
        code: expect.stringMatching(/validation_error|not_found/),
      })
    expect(await store.notes.addedAccount()).toBeUndefined()
  })
})

describe("a source added by hand, with others at work", () => {
  const agent = { bot: "memo-agent", model: "local/model", reason: "the notes name the project" }

  it("turns an agent's proposed subject into the owner's when the owner adds it too", async () => {
    const { store, lighthouse } = await setup()
    const { note } = await store.notes.saveAddedSource({ ...file, by: agent, subjects: [lighthouse] })
    expect(await store.notes.links({ from: note.ref })).toEqual([
      expect.objectContaining({ origin: "suggested", confirmed: false, provenance: agent.reason }),
    ])
    await store.notes.saveAddedSource({ ...file, subjects: [lighthouse] })
    expect(await store.notes.links({ from: note.ref })).toEqual([
      expect.objectContaining({ origin: "owner", confirmed: true }),
    ])
  })

  it("records the agent that proposed a subject, and its model", async () => {
    const { store, sql, lighthouse } = await setup()
    await store.notes.saveAddedSource({ ...file, by: agent, subjects: [lighthouse] })
    expect(await sql("SELECT author, metadata FROM links WHERE kind = 'about'")).toEqual([
      { author: "memo-agent", metadata: JSON.stringify({ provenance: agent.reason, model: "local/model" }) },
    ])
  })

  it("answers a live folder document as duplicate_of even when its own removed row is still there", async () => {
    const { store, sql } = await setup()
    const own = await store.notes.saveAddedSource(file)
    await store.notes.removeAddedSource(own.note.ref, "owner")
    const folder = await store.notes.addFolder({ name: "Work", format: "markdown" })
    const { note } = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "runner.pdf",
      title: null,
      text: file.text,
      contentHash: sha(pdf),
    })
    expect(await store.notes.saveAddedSource(file)).toMatchObject({ duplicateOf: note.ref, kept: null })
    expect(await sql("SELECT count(*) AS n FROM documents WHERE deleted_at IS NULL")).toEqual([{ n: 1 }])
  })

  it("names its file by the file's name, else its title, never its hash", async () => {
    const { store, sql } = await setup()
    await store.notes.saveAddedSource({ ...file, fileName: "runner.pdf", title: "Runner notes" })
    await store.notes.saveAddedSource({ by: "owner", kind: "text", read: "extracted", text: "Pasted", title: "Call" })
    expect(await sql("SELECT name, path FROM files WHERE kind <> 'folder' ORDER BY id")).toEqual([
      { name: "runner.pdf", path: "runner.pdf" },
      { name: "Call", path: "Call" },
    ])
  })

  it("tells the caller before any write whether a copy would be kept, so no copy is orphaned", async () => {
    const { store } = await setup()
    expect(addedSourceKeyOf(file).externalId).toBe(`sha256:${sha(pdf)}`)
    expect(await store.notes.findAddedSource(file)).toEqual({ existing: null, duplicateOf: null })
    const folder = await store.notes.addFolder({ name: "Work" })
    const input = { folderId: folder.id, path: "a.pdf", title: null, text: "x", contentHash: sha(pdf) }
    const { note } = await store.notes.saveFileNote(input)
    expect(await store.notes.findAddedSource(file)).toEqual({ existing: null, duplicateOf: note.ref })
    await store.notes.deleteFileNotes(folder.id, ["a.pdf"])
    const own = await store.notes.saveAddedSource(file)
    expect(await store.notes.findAddedSource(file)).toEqual({ existing: own.note.ref, duplicateOf: null })
    expect(await store.notes.addedAccount()).toBeDefined()
  })

  it("is removed by the owner only, through the deletion folder files use, and gives back its copy's path", async () => {
    const { store } = await setup()
    const { note } = await store.notes.saveAddedSource({ ...file, keepCopy: { path: "/var/tmp/copies/runner.pdf" } })
    await expect(store.notes.removeAddedSource(note.ref, agent)).rejects.toMatchObject({ code: "permission_error" })
    expect(await store.notes.removeAddedSource(note.ref, "owner")).toEqual({
      ref: note.ref,
      removed: true,
      copy: "/var/tmp/copies/runner.pdf",
    })
    expect(await store.notes.note(note.ref)).toMatchObject({ text: "", deletedAt: expect.any(String) })
    expect((await searchNotesQuery(store, { text: "quinoaplan", limit: 5 })).items).toEqual([])
    await expect(store.notes.removeAddedSource(note.ref, "owner")).rejects.toMatchObject({ code: "not_found" })
    const folder = await store.notes.addFolder({ name: "Work" })
    const { note: other } = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "a.md",
      title: null,
      text: "x",
    })
    await expect(store.notes.removeAddedSource(other.ref, "owner")).rejects.toMatchObject({ code: "not_found" })
  })

  it("goes with its account when the account is purged", async () => {
    const { store, sql, lighthouse } = await setup()
    await store.notes.saveAddedSource({ ...file, subjects: [lighthouse] })
    await store.accounts.purge({ provider: "added", account: "owner" })
    expect(await store.notes.addedAccount()).toBeUndefined()
    expect(
      await sql(
        "SELECT (SELECT count(*) FROM documents) AS documents, (SELECT count(*) FROM files) AS files, (SELECT count(*) FROM links) AS links",
      ),
    ).toEqual([{ documents: 0, files: 0, links: 0 }])
  })

  it("is a missing binding in a document transfer, never matched to a folder by the name null", async () => {
    const root = mkdtempSync(join(tmpdir(), "added-transfer-"))
    const [source, destination] = [join(root, "source.db"), join(root, "destination.db")]
    const store = await openStore({ path: source })
    const folder = await store.notes.addFolder({ name: "Work" })
    const { note } = await store.notes.saveFileNote({ folderId: folder.id, path: "a.md", title: null, text: "Plan" })
    const added = await store.notes.saveAddedSource(file)
    await store.notes.addLink({ by: "owner", from: note.ref, to: added.note.ref, kind: "related-to" })
    await store.close()
    const target = await openStore({ path: destination })
    const decoy = await target.notes.addFolder({ name: "null" })
    await target.notes.saveFileNote({
      folderId: decoy.id,
      path: added.note.path as string,
      title: null,
      text: file.text,
    })
    await target.close()
    const preview = await previewDocumentTransfer({ source, destination, collection: "Work" })
    expect(preview.missing_bindings).toContain(added.note.ref)
    expect(preview.conflicts).toEqual([])
  })
})

describe("a source added by hand under a source key", () => {
  const page = (text: string, sourceKey = "google-drive:SyntheticDoc_1") =>
    ({
      kind: "page",
      read: "extracted",
      text,
      url: "https://docs.google.com/document/d/SyntheticDoc_1/edit",
      title: "Harbour budget",
      sourceKey,
      by: "owner",
    }) as const

  it("is updated in place when its text changed, and a confirmed memory citing the old words gets a review", async () => {
    const { store, sql } = await setup()
    const first = await store.notes.saveAddedSource(page("Hosting costs 120 a month."))
    expect(first).toMatchObject({ created: true, changed: true })
    expect(first.note.path).toBe("google-drive:SyntheticDoc_1")
    const memory = await store.memories.add({
      kind: "preference",
      body: "Hosting is 120 a month",
      scope: "work",
      evidence: [{ ref: first.note.ref, quote: "costs 120 a month" }],
      author: "owner",
      status: "confirmed",
    })
    const again = await store.notes.saveAddedSource(page("Hosting costs 150 a month."))
    expect(again).toMatchObject({ created: false, changed: true, duplicateOf: null, kept: "text" })
    expect(again.note).toMatchObject({ ref: first.note.ref, revision: 2, text: "Hosting costs 150 a month." })
    expect(await sql("SELECT count(*) AS n FROM documents")).toEqual([{ n: 1 }])
    expect(await sql("SELECT body, revision FROM document_revisions")).toEqual([
      { body: "Hosting costs 120 a month.", revision: 1 },
    ])
    expect(await store.knowledge.checkSources()).toMatchObject({ raised: 1 })
    expect(await store.memories.get(memory.ref)).toMatchObject({
      status: "confirmed",
      sourceReview: { cause: "changed" },
    })
  })

  it("changes nothing when it is added again with the same text", async () => {
    const { store, sql } = await setup()
    const first = await store.notes.saveAddedSource(page("Hosting costs 120 a month."))
    const again = await store.notes.saveAddedSource(page("Hosting  costs 120 a month."))
    expect(again).toMatchObject({ created: false, changed: false })
    expect(again.note).toMatchObject({ ref: first.note.ref, revision: 1, updatedAt: first.note.updatedAt })
    expect(await sql("SELECT count(*) AS n FROM document_revisions")).toEqual([{ n: 0 }])
  })

  it("keeps two keys apart even with the same text, and a key apart from the same text without one", async () => {
    const { store, sql } = await setup()
    const one = await store.notes.saveAddedSource(page("Same words.", "google-drive:SyntheticDoc_1"))
    const two = await store.notes.saveAddedSource(page("Same words.", "google-drive:SyntheticDoc_2"))
    const plain = await store.notes.saveAddedSource({
      by: "owner",
      kind: "text",
      read: "extracted",
      text: "Same words.",
    })
    expect(new Set([one.note.ref, two.note.ref, plain.note.ref]).size).toBe(3)
    expect(await sql("SELECT count(*) AS n FROM documents")).toEqual([{ n: 3 }])
    expect(await store.notes.findAddedSource(page("Other words.", "google-drive:SyntheticDoc_2"))).toEqual({
      existing: two.note.ref,
      duplicateOf: null,
    })
  })

  it.each([
    "sha256:abc",
    "no-namespace",
    "Google Drive:x",
    "google-drive:",
    "google-drive:a/b",
    `x:${"a".repeat(201)}`,
  ])("refuses the source key %s", async (sourceKey) => {
    const { store } = await setup()
    await expect(store.notes.saveAddedSource(page("Words.", sourceKey))).rejects.toMatchObject({
      code: "validation_error",
    })
  })
})
