import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { CliError, isCliError } from "@wirecat/cli-base"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DocumentSource, SourceChange, SourceFile, SourceState, SourceWalk } from "../../documents/model.js"
import { within } from "../../documents/scope.js"
import { type MessageStore, openStore } from "../../store/index.js"
import { documentIngestion } from "./ingestion.js"
import { documentKnowledge } from "./knowledge.js"
import type { SyncOptions } from "./ports.js"
import { syncDocuments } from "./sync.js"

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("missing synthetic fixture")
  return value
}
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const file = (id: string, parents: string[] = ["root"], mime = "text/plain"): SourceFile => ({
  id,
  name: id,
  parents,
  mime,
  url: `https://example.invalid/${id}`,
  trashed: false,
  canDownload: true,
  version: "1",
})
const setup = async (provider = "synthetic-box") => {
  const store = await openStore({ path: join(mkdtempSync("/var/tmp/document-services-"), "store.db") })
  live.push(store)
  const files = new Map([
    ["root", file("root", [], "inode/directory")],
    ["nested", file("nested", ["root"], "inode/directory")],
    ["a", file("a", ["nested"])],
    ["b", file("b")],
  ])
  let changes: SourceChange[] = []
  let state: SourceState = { version: 1, principal: "alpha", scope: "", folders: {}, documents: {}, skipped: [] }
  let walk: SourceWalk | undefined
  const snapshots = new Map()
  const source: DocumentSource = {
    identity: async () => "alpha",
    metadata: vi.fn(async (id) => {
      const found = files.get(id)
      if (!found) throw new CliError("not_found", "gone")
      return found
    }),
    children: vi.fn(async (id) => [...files.values()].filter((item) => item.parents.includes(id))),
    startToken: vi.fn(async () => "before"),
    changes: vi.fn(async () => ({ items: changes, cursor: "after" })),
    content: vi.fn(async (id) => ({
      metadata: must(files.get(id)),
      text: `budget ${id} ${files.get(id)?.version}`,
      markdown: `budget ${id}`,
      tabs: [],
    })),
    bytes: vi.fn(async () => Uint8Array.of(1)),
  }
  const ingest = documentIngestion(store, {
    collectionName: (account) => `${provider}:${account}`,
    externalId: (id) => id,
    catalogInput: (item: SourceFile) => ({
      externalId: item.id,
      name: item.name,
      parents: item.parents,
      kind: item.mime === "inode/directory" ? "folder" : "file",
      url: item.url,
      mime: item.mime,
    }),
    frontMatter: (content) => ({ source: provider, sourceUrl: content.metadata.url }),
  })
  const writer = { save: vi.fn(async () => "saved" as const), close: vi.fn(async () => {}) }
  const options: SyncOptions<SourceFile> = {
    source,
    index: { ...ingest, openPictures: vi.fn(async () => writer) },
    principal: "alpha",
    roots: ["root"],
    textLimit: 200000,
    max: 100,
    maxEntries: 10000,
    storeVersion: "fixture-1",
    isFolder: (item) => item.mime === "inode/directory",
    skipReason: (item) =>
      !item.canDownload
        ? "downloads restricted"
        : item.mime === "text/plain"
          ? undefined
          : `unsupported type: ${item.mime}`,
    retryable: () => true,
    errorOf: (error) => (isCliError(error) ? error : new CliError("provider_error", "synthetic request failed")),
    assertHeld: vi.fn(),
    now: () => Date.UTC(2026, 9, 16),
    state: {
      read: () => structuredClone(state),
      save: (next) => {
        state = structuredClone(next)
      },
      readWalk: (scope) => (walk?.scope === scope ? structuredClone(walk) : undefined),
      saveWalk: (next) => {
        walk = structuredClone(next)
      },
      removeWalk: () => {
        walk = undefined
      },
      saveSnapshot: (content) => {
        snapshots.set(content.metadata.id, content)
      },
      removeSnapshot: (id) => {
        snapshots.delete(id)
      },
    },
  }
  const knowledge = documentKnowledge(store, async (account) => (await ingest.collection(account, false))?.id)
  return {
    store,
    files,
    source,
    ingest,
    options,
    writer,
    snapshots,
    knowledge,
    state: () => state,
    walk: () => walk,
    changes: (items: SourceChange[]) => {
      changes = items
    },
  }
}

describe("provider-neutral document sync", () => {
  it.each(["synthetic-box", "synthetic-onedrive"])(
    "imports and resumes %s with folder metadata and a durable cursor",
    async (provider) => {
      const f = await setup(provider)
      expect(await syncDocuments({ ...f.options, max: 1 })).toMatchObject({ saved: 1, pending: 1 })
      expect(f.state().cursor).toBeUndefined()
      expect(await syncDocuments(f.options)).toMatchObject({ saved: 1, pending: 0 })
      expect(f.state().cursor).toBe("before")
      const folder = await f.ingest.collection("alpha", false)
      expect((await f.store.catalog.list(must(folder).id)).items).toHaveLength(4)
      expect(f.snapshots.size).toBe(2)
      expect(await syncDocuments(f.options)).toMatchObject({ saved: 0, pending: 0 })
      expect(f.state().cursor).toBe("after")
      expect(f.state().lastSync).toBe("2026-10-16T00:00:00.000Z")
    },
  )
  it("retains failed work, resumes an interrupted discovery and refuses invalid source identity", async () => {
    const f = await setup()
    vi.mocked(f.source.children).mockRejectedValueOnce(new Error("interrupted discovery"))
    await expect(syncDocuments(f.options)).rejects.toThrow("interrupted discovery")
    expect(f.walk()?.stack.length).toBeGreaterThan(0)
    vi.mocked(f.source.content).mockRejectedValueOnce(new Error("interrupted download"))
    expect(await syncDocuments(f.options)).toMatchObject({ pending: 1, errors: [{ code: "provider_error" }] })
    expect(await syncDocuments(f.options)).toMatchObject({ pending: 0 })
    await expect(
      syncDocuments({ ...f.options, source: { ...f.source, identity: async () => "beta" } }),
    ).rejects.toThrow("does not match")
    await expect(syncDocuments({ ...f.options, max: 0 })).rejects.toThrow("positive")
    await expect(syncDocuments({ ...f.options, signal: AbortSignal.abort() })).rejects.toThrow("cancelled")
    const state = f.state()
    state.principal = "beta"
    await expect(syncDocuments(f.options)).rejects.toThrow("another source account")
  })
  it("keeps owner annotations, stales changed-source memories and retires descendants on folder exit", async () => {
    const f = await setup()
    await syncDocuments(f.options)
    const ref = must(f.state().documents.a).reference
    await f.knowledge.tags("alpha", ref, "add", ["review"])
    const memo = await f.knowledge.addNote("alpha", ref, "Owner memo")
    const memory = await f.knowledge.addMemory("alpha", ref, {
      author: "owner",
      body: "Budget summary",
      kind: "summary",
      scope: "work",
    })
    f.files.set("a", { ...must(f.files.get("a")), version: "2" })
    f.changes([{ id: "a", removed: false, file: f.files.get("a") }])
    await syncDocuments(f.options)
    expect((await f.knowledge.memory("alpha", ref, memory.ref)).status).toBe("stale")
    expect(await f.knowledge.tags("alpha", ref, "list")).toEqual(["review"])
    expect((await f.knowledge.note("alpha", ref, memo.ref)).text).toBe("Owner memo")
    f.files.set("nested", { ...must(f.files.get("nested")), trashed: true })
    f.changes([{ id: "nested", removed: true }])
    expect(await syncDocuments(f.options)).toMatchObject({ removed: 1 })
    expect(f.snapshots.has("a")).toBe(false)
    await expect(f.knowledge.document("alpha", ref)).rejects.toThrow("account")
  })
  it("removes abandoned pending work when selected scope changes, and supports a full rescan", async () => {
    const f = await setup()
    await syncDocuments({ ...f.options, max: 1 })
    expect(await syncDocuments({ ...f.options, roots: [], source: undefined })).toMatchObject({
      removed: 2,
      pending: 0,
    })
    expect(await syncDocuments({ ...f.options, rescan: true })).toMatchObject({ saved: 2 })
    f.files.set("root", { ...must(f.files.get("root")), trashed: true })
    f.changes([])
    expect(await syncDocuments(f.options)).toMatchObject({ removed: 2, skipped: [{ id: "root" }] })
  })
  it("indexes unsupported files as metadata and closes an optional picture writer", async () => {
    const f = await setup()
    f.files.set("b", { ...must(f.files.get("b")), mime: "image/png" })
    expect(await syncDocuments({ ...f.options, pictures: true })).toMatchObject({ names_only: 1, pictures: 1 })
    expect(f.writer.close).toHaveBeenCalledOnce()
    expect(f.state().documents.b?.picture).toBe("saved")
    expect(() => within(file("cycle", ["cycle"]), ["root"], { cycle: file("cycle", ["cycle"]) })).toThrow("cycle")
  })
  it("refuses incomplete, cyclic and over-budget folder discovery without advancing state", async () => {
    const f = await setup()
    await expect(syncDocuments({ ...f.options, maxEntries: 1 })).rejects.toThrow("entry limit")
    const cycle = { ...must(f.files.get("root")), parents: ["nested"] }
    f.files.set("root", cycle)
    await expect(syncDocuments(f.options)).rejects.toThrow("cycle")
    expect(f.state().cursor).toBeUndefined()
  })

  describe("a saved query beside the selected folders", () => {
    const transcript = (id: string, parents = ["someone-elses-folder"]) => ({
      ...file(id, parents),
      name: `${id} - Transcript`,
    })
    const matches = (item: SourceFile) => item.name.endsWith(" - Transcript")
    it("include imports what the query finds wherever it sits, keeps it updated and drops it when it stops matching", async () => {
      const f = await setup()
      const shared = transcript("shared")
      f.files.set("shared", shared)
      const list = vi.fn(async () => [shared, { ...file("other", []), name: "unrelated" }])
      const query = { key: "transcripts", mode: "include" as const, matches, list }
      expect(await syncDocuments({ ...f.options, roots: [], query })).toMatchObject({
        saved: 1,
        coverage: expect.stringContaining("saved query finds"),
      })
      expect(Object.keys(f.state().documents)).toEqual(["shared"])
      const folder = await f.ingest.collection("alpha", false)
      expect((await f.store.catalog.list(must(folder).id)).items.map(({ name }) => name)).toEqual([
        "shared - Transcript",
      ])
      expect(await syncDocuments({ ...f.options, roots: [], query })).toMatchObject({ saved: 0, removed: 0 })
      list.mockResolvedValueOnce([{ ...shared, version: "2" }])
      f.files.set("shared", { ...shared, version: "2" })
      expect(await syncDocuments({ ...f.options, roots: [], query })).toMatchObject({ saved: 1 })
      list.mockResolvedValueOnce([])
      expect(await syncDocuments({ ...f.options, roots: [], query })).toMatchObject({ removed: 1 })
      expect(f.state().documents).toEqual({})
    })
    it("include adds to the selected folders, and turning it off removes only what it added", async () => {
      const f = await setup()
      f.files.set("shared", transcript("shared"))
      const query = { key: "transcripts", mode: "include" as const, matches, list: async () => [transcript("shared")] }
      expect(await syncDocuments({ ...f.options, query })).toMatchObject({ saved: 3 })
      expect(await syncDocuments(f.options)).toMatchObject({ removed: 1 })
      expect(Object.keys(f.state().documents).sort()).toEqual(["a", "b"])
    })
    it("does not read a listed file again that keeps failing, and keeps the checkpoint when listing fails", async () => {
      const f = await setup()
      const list = vi.fn(async () => [transcript("gone")])
      const query = { key: "transcripts", mode: "include" as const, matches, list }
      const options = { ...f.options, roots: [], query, retryable: () => false }
      vi.mocked(f.source.content).mockRejectedValue(new CliError("not_found", "gone"))
      for (let run = 0; run < 3; run++) await syncDocuments(options)
      expect(f.source.content).toHaveBeenCalledOnce()
      const cursor = f.state().cursor
      list.mockRejectedValueOnce(new CliError("provider_error", "listing failed"))
      await expect(syncDocuments(options)).rejects.toThrow("listing failed")
      expect(f.state().cursor).toBe(cursor)
      await expect(
        syncDocuments({ ...options, query: { key: "transcripts", mode: "include", matches } }),
      ).rejects.toThrow("must list them")
    })
    it("finishes a pending batch of listed files across runs", async () => {
      const f = await setup()
      for (const id of ["one", "two", "three"]) f.files.set(id, transcript(id))
      const query = {
        key: "transcripts",
        mode: "include" as const,
        matches,
        list: async () => ["one", "two", "three"].map((id) => transcript(id)),
      }
      expect(await syncDocuments({ ...f.options, roots: [], query, max: 2 })).toMatchObject({ saved: 2, pending: 1 })
      expect(await syncDocuments({ ...f.options, roots: [], query, max: 2 })).toMatchObject({ saved: 1, pending: 0 })
      expect(Object.keys(f.state().documents).sort()).toEqual(["one", "three", "two"])
    })
    it("exclude keeps matching files out even inside a selected folder", async () => {
      const f = await setup()
      f.files.set("b", transcript("b", ["root"]))
      await syncDocuments(f.options)
      expect(Object.keys(f.state().documents).sort()).toEqual(["a", "b"])
      const query = { key: "transcripts", mode: "exclude" as const, matches }
      expect(await syncDocuments({ ...f.options, query })).toMatchObject({ removed: 1 })
      expect(Object.keys(f.state().documents)).toEqual(["a"])
      f.files.set("a", transcript("a", ["nested"]))
      f.changes([{ id: "a", removed: false, file: f.files.get("a") }])
      expect(await syncDocuments({ ...f.options, query })).toMatchObject({ removed: 1 })
      expect(f.state().documents).toEqual({})
    })
  })
})
