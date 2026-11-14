import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { SourceFile } from "../../documents/model.js"
import { useProviders } from "../../domain/providers.js"
import { type MessageStore, openStore } from "../../store/index.js"
import { openCache } from "../../store/open.js"
import { contextDocumentTime, contextDocumentUrl } from "../../store/sqlite/context-document-source.js"
import { refAccountsOf } from "../../store/sqlite/ref-accounts.js"
import { documentIngestion } from "./ingestion.js"

const WIKI = "synthetic-wiki"
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
  useProviders([])
})

const setup = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "documents-provider-")), "store.db")
  const store = await openStore({ path })
  opened.push(store)
  await store.accounts.registerProvider({ name: WIKI, kind: "documents", aliases: [], command: "wiki" })
  const query = async <T>(run: (database: Awaited<ReturnType<typeof openCache>>) => T) => {
    const database = await openCache(path)
    try {
      return run(database)
    } finally {
      database.close()
    }
  }
  return { store, path, query }
}

const page = (id: string, parents: string[]): SourceFile => ({
  id,
  name: `Page ${id}`,
  parents,
  mime: "text/markdown",
  url: `https://wiki.invalid/${id}`,
  trashed: false,
  canDownload: true,
  version: "1",
})

const ingestion = (store: MessageStore) =>
  documentIngestion(store, {
    provider: WIKI,
    externalId: (id) => `${id}.md`,
    catalogInput: (file: SourceFile) => ({
      externalId: `${file.id}.md`,
      kind: file.id === "root" ? "folder" : "file",
      name: file.name,
      parents: file.parents.map((id) => `${id}.md`),
      url: file.url,
    }),
    frontMatter: (content) => ({ source: WIKI, sourceUrl: content.metadata.url }),
  })

describe("a documents provider other than Drive", () => {
  it("has documents accounts once its CLI registers it, beside Drive's; an import or unknown provider has none", async () => {
    const { store } = await setup()
    await store.notes.documentsAccount({ provider: "google-drive", account: "ana@example.com" }, true)
    const wiki = await store.notes.documentsAccount({ provider: WIKI, account: "space-1" }, true)
    expect(wiki).toMatchObject({ name: `${WIKI}:space-1`, account: { provider: WIKI, account: "space-1" } })
    expect((await store.notes.documentsAccounts()).map(({ provider }) => provider)).toEqual(["google-drive", WIKI])
    for (const provider of ["import", "unregistered-wiki"])
      await expect(store.notes.documentsAccount({ provider, account: "x" }, true)).rejects.toMatchObject({
        code: "validation_error",
      })
  })

  it("keeps its pages by id under their catalog parents, as Drive's files are kept", async () => {
    const { store, query } = await setup()
    const ingest = ingestion(store)
    await ingest.catalog.import("space-1", [page("root", []), page("child", ["root"])])
    await ingest.save(
      "space-1",
      { metadata: page("child", ["root"]), text: "the quarterly plan", markdown: "", tabs: [] },
      "hash-1",
    )
    const rows = await query((database) =>
      database.prepare("SELECT external_id, path, kind FROM files WHERE kind = 'file' ORDER BY path").all(),
    )
    expect(rows).toEqual([{ external_id: "child.md", path: "Page root/Page child", kind: "file" }])
  })

  it("does not join a vault file carrying its front matter to its page by content", async () => {
    const { store } = await setup()
    const ingest = ingestion(store)
    const ref = await ingest.save(
      "space-1",
      { metadata: page("child", []), text: "the quarterly plan", markdown: "", tabs: [] },
      "hash-1",
    )
    const vault = await store.notes.addFolder({ name: "Vault" })
    const { note } = await store.notes.saveFileNote({
      folderId: vault.id,
      path: "export.md",
      title: null,
      text: "the quarterly plan",
      contentHash: "hash-1",
      frontMatter: { source: WIKI },
    })
    expect(note.ref).not.toBe(ref)
  })

  it("names its account as a notes account in a reference's accounts", async () => {
    const { store, query } = await setup()
    const ref = await ingestion(store).save(
      "space-1",
      { metadata: page("child", []), text: "plan", markdown: "", tabs: [] },
      "hash-2",
    )
    const account = await store.notes.documentsAccount({ provider: WIKI, account: "space-1" })
    expect(await query((database) => refAccountsOf(database, ref))).toEqual([
      { provider: "notes", account: account?.id },
    ])
  })

  it("reads a page saved without catalog metadata by its front matter, which stands in when no file row has a link", async () => {
    const { store, path, query } = await setup()
    const account = await store.notes.documentsAccount({ provider: WIKI, account: "space-1" }, true)
    const front = {
      source: WIKI,
      fileId: "p1",
      sourceUrl: "https://wiki.invalid/p1",
      modifiedAt: "2026-11-01T10:00:00Z",
    }
    const { note } = await store.notes.saveFileNote({
      folderId: account?.id ?? "",
      path: "p1.md",
      title: "Plan",
      text: "plan",
      frontMatter: front,
    })
    expect(
      await query((database) =>
        database.prepare("SELECT external_id, url, external_updated_at FROM files WHERE document_id = ?").get(note.id),
      ),
    ).toEqual({ external_id: "p1", url: front.sourceUrl, external_updated_at: Date.parse(front.modifiedAt) })

    const database = await openCache(path)
    try {
      database.prepare("UPDATE files SET url = NULL, external_updated_at = NULL WHERE document_id = ?").run(note.id)
      const read = () =>
        database
          .prepare(
            `SELECT ${contextDocumentUrl()} AS url, ${contextDocumentTime()} AS at FROM documents n WHERE n.id = ?`,
          )
          .get(note.id)
      expect(read()).toEqual({ url: front.sourceUrl, at: Date.parse(front.modifiedAt) })
      database
        .prepare("UPDATE documents SET front_matter = json_set(front_matter, '$.source', 'unregistered') WHERE id = ?")
        .run(note.id)
      expect(read()?.url).toBeNull()
    } finally {
      database.close()
    }
  })
})
