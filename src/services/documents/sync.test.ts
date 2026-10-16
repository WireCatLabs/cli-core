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
    const memory = await f.knowledge.addMemory("alpha", ref, { body: "Budget summary", kind: "summary", scope: "work" })
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
})
