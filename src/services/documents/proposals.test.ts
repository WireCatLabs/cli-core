import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type MessageStore, openStore } from "../../store/index.js"
import { documentKnowledge } from "./knowledge.js"
import { extractDocumentMemories, type ImportedSource, type ProposalOptions } from "./proposals.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})
const setup = async () => {
  const store = await openStore({ path: join(mkdtempSync("/var/tmp/source-proposals-"), "store.db") })
  stores.push(store)
  const folder = await store.notes.addFolder({ name: "synthetic-provider:account" })
  const { note } = await store.notes.saveFileNote({
    folderId: folder.id,
    path: "source",
    title: "Source",
    text: "The budget is approved.",
  })
  let source: ImportedSource = {
    id: "source",
    ref: note.ref,
    hash: "snapshot-one",
    snapshot: {
      metadata: {
        id: "source",
        name: "Source",
        mime: "text/plain",
        parents: [],
        url: "https://example.invalid/source",
        trashed: false,
        canDownload: true,
      },
      text: "The budget is approved. SIBLING_CANARY",
      markdown: "The budget is approved.",
      tabs: [{ id: "main", title: "Main", text: "The budget is approved." }],
    },
  }
  const knowledge = documentKnowledge(store, async (account) => (account === "account" ? folder.id : undefined))
  const complete = vi.fn(async () => ({
    text: JSON.stringify({
      items: [
        { kind: "fact", body: "Budget approved", quote: "budget is approved" },
        { kind: "summary", body: "Budget outcome", quote: "budget is approved" },
      ],
    }),
    tokens: 10,
    model: "synthetic-model",
    provider: "synthetic",
  }))
  const withWrite = vi.fn()
  const options: ProposalOptions = {
    read: () => source,
    complete,
    scope: "work",
    author: "synthetic-extractor",
    tab: "main",
    withWrite: async (write) => {
      withWrite()
      return write(knowledge, "account", note.ref)
    },
  }
  return {
    store,
    note,
    knowledge,
    options,
    complete,
    withWrite,
    change: () => {
      source = { ...source, hash: "snapshot-two" }
    },
  }
}
describe("document extraction workflow", () => {
  it("previews selected text without writes, then saves proposals with evidence and source identity", async () => {
    const f = await setup()
    expect((await extractDocumentMemories(f.options)).saved).toEqual([])
    expect(f.withWrite.mock.calls).toHaveLength(0)
    expect(f.complete.mock.calls[0]).toEqual([
      expect.objectContaining({ data: "The budget is approved.", allowSourceQuotes: true }),
    ])
    const saved = await extractDocumentMemories({ ...f.options, save: true })
    expect(saved.provenance).toMatchObject({
      document: f.note.ref,
      file_id: "source",
      tab: "main",
      hash: "snapshot-one",
    })
    expect(saved.saved.map((item) => item.status)).toEqual(["proposed", "proposed"])
    expect(await f.knowledge.facts("account", f.note.ref)).toHaveLength(1)
    expect((await f.knowledge.memories("account", f.note.ref))[0]?.body).toContain("Snapshot: snapshot-one")
    expect((await f.knowledge.memories("account", f.note.ref))[0]?.author.name).toBe("synthetic-extractor")
  })
  it("rejects missing tabs and invalid evidence before acquiring a write port", async () => {
    const f = await setup()
    await expect(extractDocumentMemories({ ...f.options, tab: "missing", save: true })).rejects.toThrow("tab")
    f.complete.mockResolvedValueOnce({
      text: JSON.stringify({ items: [{ kind: "fact", body: "Invented", quote: "Invented source quote" }] }),
      tokens: 1,
      model: "synthetic-model",
      provider: "synthetic",
    })
    await expect(extractDocumentMemories({ ...f.options, save: true })).rejects.toThrow("source quote")
    expect(f.withWrite.mock.calls).toHaveLength(0)
    expect(await f.knowledge.facts("account", f.note.ref)).toEqual([])
  })
  it("rejects a changed source after model execution and again inside the write lock", async () => {
    const first = await setup()
    const complete = async (...args: Parameters<ProposalOptions["complete"]>) => {
      const answer = await first.options.complete(...args)
      first.change()
      return answer
    }
    await expect(extractDocumentMemories({ ...first.options, complete, save: true })).rejects.toThrow("source changed")
    expect(first.withWrite.mock.calls).toHaveLength(0)
    const second = await setup()
    await expect(
      extractDocumentMemories({
        ...second.options,
        save: true,
        withWrite: async (write) => {
          second.change()
          return write(second.knowledge, "account", second.note.ref)
        },
      }),
    ).rejects.toThrow("source changed")
    expect(await second.knowledge.memories("account", second.note.ref)).toEqual([])
    await expect(
      extractDocumentMemories({
        ...second.options,
        save: true,
        withWrite: async (write) => write(second.knowledge, "account", "document:wrong-source"),
      }),
    ).rejects.toThrow("source changed")
    expect(await second.knowledge.facts("account", second.note.ref)).toEqual([])
  })
})
