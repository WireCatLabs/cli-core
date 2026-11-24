import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { rekeySyncedDocument } from "../../cli/documents/rekey.js"
import type { SourceFile } from "../../documents/model.js"
import { useProviders } from "../../domain/providers.js"
import { type MessageStore, openStore } from "../../store/index.js"
import { documentIngestion } from "./ingestion.js"

const DISK = "synthetic-disk"
const PROVIDER = { name: DISK, kind: "documents", aliases: [], command: "disk" } as const
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
  useProviders([])
})

const setup = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "documents-rekey-")), "store.db")
  const store = await openStore({ path })
  opened.push(store)
  await store.accounts.registerProvider(PROVIDER)
  return { store, path }
}

const file = (id: string): SourceFile => ({
  id,
  name: "plan.md",
  parents: [],
  mime: "text/markdown",
  url: "https://disk.invalid/plan.md",
  trashed: false,
  canDownload: true,
  version: id,
})

const ingestion = (store: MessageStore) =>
  documentIngestion(store, {
    provider: DISK,
    externalId: (id) => `${id}.md`,
    catalogInput: (one: SourceFile) => ({
      externalId: `${one.id}.md`,
      kind: "file",
      name: one.name,
      parents: [],
      url: one.url,
    }),
    frontMatter: (content) => ({ source: DISK, sourceUrl: content.metadata.url }),
  })

/** A synced file the owner tagged and wrote a note about. */
const synced = async (store: MessageStore) => {
  const ingest = ingestion(store)
  const ref = await ingest.save("acct", { metadata: file("old"), text: "the first plan", markdown: "", tabs: [] }, "h1")
  await store.knowledge.addTags(null, { type: "document", id: ref.slice("document:".length) }, ["harbour"])
  const note = await store.notes.addNote({ text: "check the dates", about: [ref] })
  return { ingest, ref, note }
}

const kept = async (store: MessageStore, ref: string, noteRef: string) => {
  expect((await store.notes.noteTags(ref)).map((tag) => tag.tag)).toEqual(["harbour"])
  expect((await store.notes.notes({ source: "internal", about: ref })).items.map((one) => one.ref)).toEqual([noteRef])
}

it("moves a synced document to the file's new id, keeping its tags and the notes about it", async () => {
  const { store } = await setup()
  const { ingest, ref, note } = await synced(store)
  expect(await ingest.rekey("acct", "old", "new")).toBe(true)
  const folder = await ingest.collection("acct", false)
  expect((await store.notes.fileNote(folder?.id as string, "new.md"))?.ref).toBe(ref)
  expect(await store.notes.fileNote(folder?.id as string, "old.md")).toBeUndefined()
  await kept(store, ref, note.ref)
  // The next sync of the file under its new id updates the same document.
  const again = await ingest.save(
    "acct",
    { metadata: file("new"), text: "the second plan", markdown: "", tabs: [] },
    "h2",
  )
  expect(again).toBe(ref)
  await kept(store, ref, note.ref)
})

it("folds in a sync that filed the file anew before the move, and brings the old document back", async () => {
  const { store } = await setup()
  const { ingest, ref, note } = await synced(store)
  await ingest.catalog.import("acct", [file("new")])
  await ingest.save("acct", { metadata: file("new"), text: "the second plan", markdown: "", tabs: [] }, "h2")
  await ingest.remove("acct", "old")
  expect(await ingest.rekey("acct", "old", "new")).toBe(true)
  const folder = await ingest.collection("acct", false)
  const now = await store.notes.fileNote(folder?.id as string, "new.md")
  expect(now).toMatchObject({ ref, text: "the second plan" })
  await kept(store, ref, note.ref)
})

it("leaves a file that was never synced alone", async () => {
  const { store } = await setup()
  const ingest = ingestion(store)
  expect(await ingest.rekey("acct", "old", "new")).toBe(false)
  await synced(store)
  expect(await ingest.rekey("acct", "elsewhere", "new")).toBe(false)
})

it("opens no store that does not exist, and a failure only warns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "documents-rekey-"))
  const warnings: string[] = []
  const input = {
    env: { MESSAGING_STORE: join(dir, "none.db") },
    app: { command: "disk", version: "0.0.0" },
    provider: PROVIDER,
    account: "acct",
    from: "old",
    to: "new",
    warn: (message: string) => warnings.push(message),
  }
  expect(await rekeySyncedDocument({ ...input, ingestion })).toBe(false)
  const { path } = await setup()
  await opened.splice(0)[0]?.close()
  const failing = () => ({ rekey: () => Promise.reject(new Error("the store is busy")) })
  expect(await rekeySyncedDocument({ ...input, env: { MESSAGING_STORE: path }, ingestion: failing })).toBe(false)
  expect(warnings).toEqual(["the synced copy keeps its tags and notes under the old id old: the store is busy"])
})
