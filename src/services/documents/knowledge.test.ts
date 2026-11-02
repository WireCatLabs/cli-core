import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { SourceFile } from "../../documents/model.js"
import { openStore } from "../../store/index.js"
import { documentIngestion } from "./ingestion.js"
import { documentKnowledge } from "./knowledge.js"

const file = (id: string): SourceFile => ({
  id,
  name: id,
  parents: ["root"],
  mime: "text/plain",
  url: `https://example.invalid/${id}`,
  trashed: false,
  canDownload: true,
})
const content = (metadata: SourceFile, text = "budget decision") => ({ metadata, text, markdown: text, tabs: [] })
const setup = async () => {
  const store = await openStore({ path: join(mkdtempSync("/var/tmp/shared-knowledge-"), "store.db") })
  const principal = "synthetic-account"
  const metadata = file("doc-a")
  const ingest = documentIngestion(store, {
    collectionName: (account) => `synthetic:${account}`,
    externalId: (id) => id,
    catalogInput: (item: SourceFile) => ({ externalId: item.id, kind: "file", name: item.name, parents: [] }),
    frontMatter: () => ({}),
  })
  const ref = await ingest.save(principal, content(metadata), "hash-one")
  const k = documentKnowledge(store, async (account) => (await ingest.collection(account, false))?.id)
  return { store, principal, metadata, ref, k, index: { ...ingest, close: () => store.close() } }
}
describe("shared document knowledge", () => {
  it("preserves owner tags, notes and links on reimport and marks memories stale only on content changes", async () => {
    const f = await setup()
    try {
      expect(await f.k.tags(f.principal, f.ref, "add", ["budget", "review"])).toEqual(["budget", "review"])
      const note = await f.k.addNote(f.principal, f.ref, "Check the budget", "Review")
      const link = await f.k.addLink(f.principal, f.ref, { to: note.ref, kind: "related-to" })
      const memory = await f.k.addMemory(f.principal, f.ref, {
        body: "Budget decision",
        scope: "work",
        kind: "summary",
      })
      expect(memory).toMatchObject({ subject: f.ref, evidence: [f.ref], status: "proposed", scope: "work" })
      await f.k.memory(f.principal, f.ref, memory.ref, "confirm", "owner")
      await f.index.save(f.principal, content({ ...f.metadata, name: "Renamed" }), "hash-one")
      expect((await f.k.memory(f.principal, f.ref, memory.ref)).status).toBe("confirmed")
      expect(await f.k.tags(f.principal, f.ref, "list")).toEqual(["budget", "review"])
      expect(await f.k.tags(f.principal, f.ref, "list", [], { tag: "review" })).toEqual(["review"])
      expect(await f.k.tags(f.principal, f.ref, "list", [], { tag: "missing" })).toEqual([])
      expect(
        await f.k.links(f.principal, f.ref, { id: link.id, kind: "related-to", origin: "owner", confirmed: true }),
      ).toEqual([link])
      expect(await f.k.links(f.principal, f.ref, { role: "key" })).toEqual([])
      expect(await f.k.links(f.principal, f.ref, { id: "999999" })).toEqual([])
      expect((await f.k.links(f.principal, f.ref)).some((item) => item.id === link.id)).toBe(true)
      expect((await f.k.note(f.principal, f.ref, note.ref)).title).toBe("Review")
      await f.index.save(f.principal, content(f.metadata, "Revised decision"), "hash-two")
      expect((await f.k.memory(f.principal, f.ref, memory.ref)).status).toBe("stale")
      await f.k.tags(f.principal, f.ref, "remove", ["review"])
      await f.k.removeLink(f.principal, f.ref, link.id)
      expect(await f.k.tags(f.principal, f.ref, "list")).toEqual(["budget"])
      await expect(f.k.removeLink(f.principal, f.ref, link.id)).rejects.toThrow("attached")
    } finally {
      await f.index.close()
    }
  })
  it("finds a document's memories that rank below 200 other documents' matches", async () => {
    const f = await setup()
    try {
      const other = await f.index.save(f.principal, content(file("doc-b")), "hash")
      const memory = { body: "Budget review", scope: "work", kind: "summary" } as const
      for (let index = 0; index < 200; index += 1) await f.k.addMemory(f.principal, other, memory)
      const mine = await f.k.addMemory(f.principal, f.ref, memory)
      expect(await f.k.searchMemories(f.principal, f.ref, "budget")).toEqual({
        items: [expect.objectContaining({ ref: mine.ref })],
        limit_reached: false,
      })
    } finally {
      await f.index.close()
    }
  })
  it("scopes documents, notes and memories to their source and guards stale note edits", async () => {
    const f = await setup()
    try {
      const other = await f.index.save(f.principal, content(file("doc-b")), "hash")
      const note = await f.k.addNote(f.principal, f.ref, "Memo about budget")
      const edited = await f.k.editNote(f.principal, f.ref, note.ref, "Updated memo", note.revision)
      expect(edited.revision).toBeGreaterThan(note.revision)
      await expect(f.k.editNote(f.principal, f.ref, note.ref, "Stale edit", note.revision)).rejects.toThrow()
      await expect(f.k.note(f.principal, other, note.ref)).rejects.toThrow("attached")
      await expect(f.k.tags("other-account", f.ref, "list")).rejects.toThrow("account")
      const memory = await f.k.addMemory(f.principal, f.ref, {
        body: "Updated budget",
        kind: "summary",
        scope: "personal",
      })
      await expect(f.k.memory(f.principal, other, memory.ref)).rejects.toThrow("attached")
      await expect(
        f.k.addMemory(f.principal, other, {
          body: "Wrong source",
          kind: "summary",
          scope: "personal",
          supersedes: memory.ref,
        }),
      ).rejects.toThrow("attached")
      expect(await f.k.memories(f.principal, f.ref, { scope: "work" })).toEqual([])
      expect(await f.k.searchMemories(f.principal, f.ref, "budget", "personal")).toMatchObject({
        items: [{ ref: memory.ref }],
      })
      await f.k.memory(f.principal, f.ref, memory.ref, "stale")
      const replacement = await f.k.addMemory(f.principal, f.ref, {
        body: "Corrected budget",
        kind: "summary",
        scope: "personal",
        supersedes: memory.ref,
      })
      expect(replacement.supersedes).toBe(memory.ref)
      expect((await f.k.memory(f.principal, f.ref, memory.ref)).status).toBe("superseded")
      await f.k.removeNote(f.principal, f.ref, note.ref)
      await expect(f.k.note(f.principal, f.ref, note.ref)).rejects.toThrow("attached")
    } finally {
      await f.index.close()
    }
  })
  it("stales source-backed memories on scope removal and refuses removed documents", async () => {
    const f = await setup()
    const store = f.store
    try {
      const memory = await f.k.addMemory(f.principal, f.ref, { body: "Source summary", kind: "summary", scope: "work" })
      await f.index.remove(f.principal, "doc-a")
      expect((await store.memories.get(memory.ref)).status).toBe("stale")
      await expect(f.k.document(f.principal, f.ref)).rejects.toThrow("account")
    } finally {
      await f.index.close()
    }
  })
  it("keeps facts on their document: the owner's accepted at once, an extraction's proposed", async () => {
    const f = await setup()
    try {
      const owned = await f.k.addFact(f.principal, f.ref, { statement: "The budget was approved", type: "decision" })
      expect(owned).toMatchObject({ type: "decision", status: "accepted", subject: f.ref, evidence: [f.ref] })
      const drawn = await f.k.addFact(f.principal, f.ref, {
        statement: "Alice Example owns the budget",
        type: "fact",
        scope: "work",
        by: { bot: "drive-memory", model: "example-model" },
      })
      expect(drawn).toMatchObject({ status: "proposed", model: "example-model", scope: "work" })
      expect((await f.k.facts(f.principal, f.ref, { status: "proposed" })).map((fact) => fact.ref)).toEqual([drawn.ref])
      expect((await f.k.fact(f.principal, f.ref, drawn.ref, "confirm", "owner")).status).toBe("accepted")
      await expect(
        f.k.addMemory(f.principal, f.ref, { body: "A fact", kind: "fact" as never, scope: "work" }),
      ).rejects.toThrow("summary, digest, preference")
    } finally {
      await f.index.close()
    }
  })
  it("replaces decisions on acceptance and reverses them without changing other documents", async () => {
    const f = await setup()
    try {
      const old = await f.k.addFact(f.principal, f.ref, { statement: "Use the April budget", type: "decision" })
      const proposed = await f.k.addFact(f.principal, f.ref, {
        statement: "Use the May budget",
        type: "decision",
        supersedes: old.ref,
        occurredAt: "2026-05-01T12:00:00Z",
        by: { bot: "drive-memory", model: "example-model" },
      })
      expect(proposed).toMatchObject({ status: "proposed", supersedes: old.ref })
      expect((await f.k.fact(f.principal, f.ref, old.ref)).status).toBe("accepted")
      await expect(f.k.fact(f.principal, f.ref, proposed.ref, "reverse")).rejects.toThrow()
      expect((await f.k.fact(f.principal, f.ref, proposed.ref, "confirm", "owner")).status).toBe("accepted")
      expect((await f.k.fact(f.principal, f.ref, old.ref)).status).toBe("superseded")
      const replacement = await f.k.addFact(f.principal, f.ref, {
        statement: "Pause the budget",
        type: "decision",
        supersedes: proposed.ref,
      })
      expect(replacement).toMatchObject({ status: "accepted", supersedes: proposed.ref })
      expect((await f.k.fact(f.principal, f.ref, proposed.ref)).status).toBe("superseded")
      const other = await f.index.save(f.principal, content(file("doc-b")), "hash")
      await expect(f.k.fact(f.principal, other, replacement.ref, "reverse")).rejects.toThrow("attached")
      await expect(f.k.fact("other-account", f.ref, replacement.ref, "reverse")).rejects.toThrow("account")
      await expect(
        f.k.addFact(f.principal, other, {
          statement: "Wrong source",
          type: "decision",
          supersedes: replacement.ref,
        }),
      ).rejects.toThrow("attached")
      await expect(
        f.k.addFact("other-account", f.ref, {
          statement: "Wrong account",
          type: "decision",
          supersedes: replacement.ref,
        }),
      ).rejects.toThrow("account")
      expect(await f.k.facts(f.principal, other)).toEqual([])
      expect((await f.k.fact(f.principal, f.ref, replacement.ref)).status).toBe("accepted")
      expect((await f.k.fact(f.principal, f.ref, replacement.ref, "reverse")).status).toBe("reversed")
      const ordinary = await f.k.addFact(f.principal, f.ref, { statement: "Budget discussed", type: "fact" })
      await expect(f.k.fact(f.principal, f.ref, ordinary.ref, "reverse")).rejects.toThrow()
      await f.k.addFact(f.principal, f.ref, { statement: "Budget agreed", type: "fact", supersedes: ordinary.ref })
      expect((await f.k.fact(f.principal, f.ref, ordinary.ref)).status).toBe("superseded")
      expect(await f.k.facts(f.principal, f.ref)).toHaveLength(5)
    } finally {
      await f.index.close()
    }
  })
  it("keeps identical remote IDs separate across provider namespaces in one store", async () => {
    const f = await setup()
    try {
      const other = documentIngestion(f.store, {
        collectionName: (account) => `other-provider:${account}`,
        externalId: (id) => id,
        catalogInput: (item: SourceFile) => ({ externalId: item.id, kind: "file", name: item.name, parents: [] }),
        frontMatter: () => ({}),
      })
      const otherRef = await other.save(f.principal, content(f.metadata), "same-remote-id")
      const otherKnowledge = documentKnowledge(f.store, async (account) => (await other.collection(account, false))?.id)
      expect(otherRef).not.toBe(f.ref)
      await f.k.tags(f.principal, f.ref, "add", ["private-context"])
      expect(await otherKnowledge.tags(f.principal, otherRef, "list")).toEqual([])
      await expect(f.k.document(f.principal, otherRef)).rejects.toThrow("account")
      await expect(otherKnowledge.document(f.principal, f.ref)).rejects.toThrow("account")
    } finally {
      await f.index.close()
    }
  })
  it("**keeps a documents provider's files in its own account**, never a notes folder", async () => {
    const f = await setup()
    try {
      const drive = documentIngestion(f.store, {
        provider: "google-drive",
        externalId: (id) => `${id}.md`,
        catalogInput: (item: SourceFile) => ({
          externalId: `${item.id}.md`,
          kind: "file",
          name: item.name,
          parents: [],
        }),
        frontMatter: () => ({ source: "google-drive" }),
      })
      const ref = await drive.save(f.principal, content(f.metadata), "drive-hash")
      expect(await drive.save(f.principal, content(f.metadata), "drive-hash")).toBe(ref)
      expect(await drive.catalog.import(f.principal, [f.metadata])).toEqual({ entries: 1, retired: 0 })
      const account = await drive.collection(f.principal, false)
      expect(account).toMatchObject({
        name: `google-drive:${f.principal}`,
        format: "markdown",
        account: { provider: "google-drive", account: f.principal },
      })
      expect((await f.store.notes.folders()).map(({ name }) => name)).toEqual([`synthetic:${f.principal}`])
      expect((await f.store.notes.documentsAccounts()).map(({ id }) => id)).toEqual([account?.id])
      expect((await f.store.notes.note(ref)).folderId).toBe(account?.id)
      const knowledge = documentKnowledge(f.store, async (principal) => (await drive.collection(principal, false))?.id)
      await knowledge.tags(f.principal, ref, "add", ["drive-only"])
      expect(await knowledge.tags(f.principal, ref, "list")).toEqual(["drive-only"])
      await expect(f.store.notes.documentsAccount({ provider: "folder", account: "x" }, true)).rejects.toThrow(
        "not a provider whose accounts hold documents",
      )
    } finally {
      await f.index.close()
    }
  })
})
