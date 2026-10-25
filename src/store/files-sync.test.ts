import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openCache } from "./open.js"
import type { CatalogInput } from "./sqlite/catalog.js"
import { type MessageStore, openStore } from "./store.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const setup = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "files-sync-")), "store.db")
  const store = await openStore({ path })
  opened.push(store)
  const rows = async (sql = "SELECT * FROM files ORDER BY path") => {
    const database = await openCache(path)
    try {
      return database.prepare(sql).all()
    } finally {
      database.close()
    }
  }
  return { store, rows }
}

const entry = (externalId: string, parents: string[], kind: CatalogInput["kind"] = "file"): CatalogInput => ({
  externalId,
  kind,
  name: externalId.replace(/\.md$/, ""),
  parents,
})

describe("a notes folder", () => {
  it("is an account of provider obsidian or local by its format", async () => {
    const { store } = await setup()
    await store.notes.addFolder({ name: "Vault" })
    await store.notes.addFolder({ name: "Plain", format: "markdown" })
    expect((await store.notes.folders()).map(({ name, provider }) => [name, provider])).toEqual([
      ["Plain", "local"],
      ["Vault", "obsidian"],
    ])
  })

  it("keeps one files row per document through a save, a rename and a delete, under folder rows of its path", async () => {
    const { store, rows } = await setup()
    const folder = await store.notes.addFolder({ name: "Vault" })
    const { note } = await store.notes.saveFileNote({ folderId: folder.id, path: "A/B/one.md", title: null, text: "x" })
    expect((await rows()).map(({ path, kind }) => [path, kind])).toEqual([
      ["A", "folder"],
      ["A/B", "folder"],
      ["A/B/one.md", "file"],
    ])
    const [{ id }] = (await rows("SELECT id FROM files WHERE kind = 'file'")) as [{ id: number }]

    await store.notes.renameFileNote(folder.id, "A/B/one.md", "C/two.md")
    expect(await rows("SELECT id, external_id, path, name, document_id FROM files WHERE kind = 'file'")).toEqual([
      { id, external_id: "C/two.md", path: "C/two.md", name: "two.md", document_id: Number(note.id) },
    ])

    expect(
      await rows("SELECT linkable_type, entity_type, from_entity_id, to_entity_id, method FROM entity_link_events"),
    ).toEqual([
      {
        linkable_type: "file",
        entity_type: "document",
        from_entity_id: null,
        to_entity_id: Number(note.id),
        method: "import",
      },
    ])

    await store.notes.deleteFileNotes(folder.id, ["C/two.md"])
    expect(await rows("SELECT deleted_at IS NOT NULL AS gone FROM files WHERE kind = 'file'")).toEqual([{ gone: 1 }])
  })

  it("keys a vault file that carries a Drive export's front matter by its path, not the Drive id", async () => {
    const { store, rows } = await setup()
    const folder = await store.notes.addFolder({ name: "Vault" })
    const frontMatter = { source: "google-drive", fileId: "drive-1" }
    await store.notes.saveFileNote({
      folderId: folder.id,
      path: "Exported/plan.md",
      title: null,
      text: "x",
      frontMatter,
    })
    expect(await rows("SELECT external_id, path FROM files WHERE kind = 'file'")).toEqual([
      { external_id: "Exported/plan.md", path: "Exported/plan.md" },
    ])
  })

  it("renames onto the path of a gone note, whose document and file row go together", async () => {
    const { store, rows } = await setup()
    const folder = await store.notes.addFolder({ name: "Vault" })
    await store.notes.saveFileNote({ folderId: folder.id, path: "old.md", title: null, text: "gone" })
    await store.notes.deleteFileNotes(folder.id, ["old.md"])
    await store.notes.saveFileNote({ folderId: folder.id, path: "new.md", title: null, text: "kept" })
    await store.notes.renameFileNote(folder.id, "new.md", "old.md")
    expect(await rows("SELECT path, deleted_at FROM files WHERE kind = 'file'")).toEqual([
      { path: "old.md", deleted_at: null },
    ])
  })
})

describe("a catalog", () => {
  it("places an item written before its folder under the folder once it arrives, and moves the subtree", async () => {
    const { store, rows } = await setup()
    const { id: account } = await store.notes.addFolder({ name: "Source", format: "markdown" })
    await store.catalog.upsert(account, [entry("doc.md", ["sub.md"])])
    await store.catalog.upsert(account, [entry("sub.md", ["root.md"], "folder"), entry("root.md", [], "folder")])
    expect((await rows()).map(({ path }) => path)).toEqual(["root", "root/sub", "root/sub/doc"])

    await store.catalog.upsert(account, [{ ...entry("root.md", [], "folder"), name: "Top" }])
    expect((await rows()).map(({ path }) => path)).toEqual(["Top", "Top/sub", "Top/sub/doc"])
  })

  it("marks an item the source no longer returns as deleted, and keeps its row", async () => {
    const { store, rows } = await setup()
    const { id: account } = await store.notes.addFolder({ name: "Source", format: "markdown" })
    await store.catalog.upsert(account, [entry("a.md", []), entry("b.md", [])])
    await store.catalog.reconcile(account, ["a.md"])
    expect(await rows("SELECT path, deleted_at IS NOT NULL AS gone FROM files ORDER BY path")).toEqual([
      { path: "a", gone: 0 },
      { path: "b", gone: 1 },
    ])
  })
})

describe("the file a document shows", () => {
  it("is pinned by the owner to one of the document's own files, and unpinned again", async () => {
    const { store, rows } = await setup()
    const folder = await store.notes.addFolder({ name: "Vault" })
    const { note } = await store.notes.saveFileNote({ folderId: folder.id, path: "a.md", title: null, text: "a" })
    const { note: other } = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "b.md",
      title: null,
      text: "b",
    })
    const [file] = (await rows(`SELECT id FROM files WHERE document_id = ${note.id}`)) as [{ id: number }]
    const [otherFile] = (await rows(`SELECT id FROM files WHERE document_id = ${other.id}`)) as [{ id: number }]

    await store.files.pin(note.ref, String(file.id))
    expect(await rows(`SELECT pinned_file_id FROM documents WHERE id = ${note.id}`)).toEqual([
      { pinned_file_id: file.id },
    ])
    await expect(store.files.pin(note.ref, String(otherFile.id))).rejects.toThrow(/is not a file of/)
    await store.files.unpin(note.ref)
    expect(await rows(`SELECT pinned_file_id FROM documents WHERE id = ${note.id}`)).toEqual([{ pinned_file_id: null }])
  })
})
