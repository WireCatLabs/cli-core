import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { useProviders } from "../domain/providers.js"
import { documentSource } from "../services/document-source.js"
import { searchNotes } from "../services/notes-search.js"
import { openCache } from "./open.js"
import { type MessageStore, openStore, registerProvider } from "./store.js"

const opened: MessageStore[] = []
afterEach(async () => {
  useProviders([])
  for (const store of opened.splice(0)) await store.close()
})

const setup = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "files-area-")), "store.db")
  const store = await openStore({ path })
  opened.push(store)
  return { store, path }
}

describe("store.files", () => {
  it("lists a subtree by a prefix of the folded path, and paths holding a word in any case or accent", async () => {
    const { store } = await setup()
    const folder = await store.notes.addFolder({ name: "Vault" })
    for (const path of ["Projects/Ålpha/spec.md", "Projects/Alphabet.md", "Notes/alpha.md"])
      await store.notes.saveFileNote({ folderId: folder.id, path, title: null, text: path })
    const paths = async (query: Parameters<MessageStore["files"]["list"]>[1]) =>
      (await store.files.list(folder.id, query)).items.map(({ path }) => path)

    expect(await paths({ under: "projects/alpha" })).toEqual(["Projects/Ålpha", "Projects/Ålpha/spec.md"])
    expect(await paths({ pathContains: "ALPHA", kind: "file" })).toEqual([
      "Notes/alpha.md",
      "Projects/Ålpha/spec.md",
      "Projects/Alphabet.md",
    ])
    expect((await store.files.byPath(folder.id, "Projects/Ålpha/spec.md"))?.document).toMatch(/^document:\d+$/)
    await expect(store.files.list("999")).rejects.toThrow(/no account 999/)
  })

  it("answers a document's files with the most recently changed live one first", async () => {
    const { store } = await setup()
    const folder = await store.notes.addFolder({ name: "Source", format: "markdown" })
    await store.catalog.upsert(folder.id, [
      { externalId: "a.md", kind: "file", name: "A", parents: [], modifiedAt: "2026-01-01T00:00:00Z" },
    ])
    const [file] = (await store.files.list(folder.id)).items
    expect(file?.externalUpdatedAt).toBe("2026-01-01T00:00:00.000Z")
    expect((await store.files.ofDocument(file?.document as string)).map(({ id }) => id)).toEqual([file?.id])
  })
})

describe("documentSource", () => {
  it("takes the link from the document's file before its front matter, and search shows and filters by its edit time", async () => {
    const { store } = await setup()
    const folder = await store.notes.addFolder({ name: "google-drive:owner-1", format: "markdown" })
    await store.accounts.saveProfile("drive", "personal", { provider: "folder", account: folder.name })
    const { note } = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "file-1.md",
      title: "Plan",
      text: "plan",
      frontMatter: { source: "google-drive", fileId: "file-1", sourceUrl: "https://docs.google.com/old" },
    })
    await store.catalog.upsert(folder.id, [
      {
        externalId: "file-1.md",
        kind: "file",
        name: "Plan",
        parents: [],
        url: "https://docs.google.com/document/d/file-1",
        modifiedAt: "2026-02-01T00:00:00Z",
      },
    ])
    const [file] = await store.files.ofDocument(note.ref)
    const fresh = await store.notes.note(note.ref)
    expect(
      documentSource(fresh, await store.accounts.storedAccounts(), await store.accounts.profiles(), file),
    ).toMatchObject({
      kind: "document",
      provider: "drive",
      account: "personal",
      url: "https://docs.google.com/document/d/file-1",
    })
    const env = { WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "no-model-")) }
    const shown = async (query: string) =>
      (await searchNotes(store, query, { env, timezone: "UTC" })).hits.map(({ updated_at }) => updated_at)
    expect(await shown("plan")).toEqual(["2026-02-01T00:00:00.000Z"])
    expect(await shown("date:2026-02-01")).toEqual(["2026-02-01T00:00:00.000Z"])
    expect(await shown(`date:${fresh.updatedAt.slice(0, 10)}`)).toEqual([])
  })

  it("knows a document by its account's provider, with no front matter, once the provider is of kind documents", async () => {
    const { store, path } = await setup()
    await registerProvider(store, { name: "synthetic-docs", kind: "documents", aliases: [], command: "sdocs" })
    const folder = await store.notes.addFolder({ name: "Staging", format: "markdown" })
    const { note } = await store.notes.saveFileNote({ folderId: folder.id, path: "x.md", title: null, text: "x" })
    const accountId = await store.accounts.saveAccount(
      { provider: "synthetic-docs", account: "place-1" },
      { name: null },
    )
    await store.accounts.saveProfile("sdocs", "work", { provider: "synthetic-docs", account: "place-1" })
    const database = await openCache(path)
    database.prepare("UPDATE documents SET account_id = ? WHERE id = ?").run(accountId, Number(note.id))
    database.close()
    const moved = await store.notes.note(note.ref)
    expect(documentSource(moved, await store.accounts.storedAccounts(), await store.accounts.profiles())).toMatchObject(
      {
        kind: "document",
        provider: "sdocs",
        account: "work",
      },
    )
  })
})
