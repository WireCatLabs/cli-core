import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { SourceFile } from "../../documents/model.js"
import { type MessageStore, openStore } from "../../store/index.js"
import { documentIngestion } from "./ingestion.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const file = (i: number): SourceFile => ({
  id: `file-${i}`,
  name: `Report ${i}`,
  parents: [],
  mime: "text/plain",
  url: `https://example.invalid/${i}`,
  trashed: false,
  canDownload: true,
  version: "1",
})

const setup = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "ingestion-scale-")), "store.db") })
  opened.push(store)
  const ingest = documentIngestion(store, {
    provider: "google-drive",
    externalId: (id) => `${id}.md`,
    catalogInput: (item: SourceFile) => ({ externalId: `${item.id}.md`, kind: "file", name: item.name, parents: [] }),
    frontMatter: (content) => ({ source: "google-drive", fileId: content.metadata.id }),
  })
  return { store, ingest }
}

describe("a documents account past 10 000 entries", () => {
  it("imports, lists, saves into and retires from a catalog of any size", async () => {
    const { store, ingest } = await setup()
    const files = Array.from({ length: 10050 }, (_, i) => file(i))
    expect(await ingest.catalog.import("ana@example.com", files)).toEqual({ entries: 10050, retired: 0 })
    const page = await ingest.catalog.list("ana@example.com", { limit: 10, offset: 10040 })
    expect(page.items).toHaveLength(10)

    const last = files[10049] as SourceFile
    const ref = await ingest.save(
      "ana@example.com",
      { metadata: last, text: "late text", markdown: "", tabs: [] },
      "h1",
    )
    expect((await store.notes.note(ref)).text).toBe("late text")
    expect(
      await ingest.save("ana@example.com", { metadata: last, text: "later text", markdown: "", tabs: [] }, "h2"),
    ).toBe(ref)

    expect(await ingest.catalog.import("ana@example.com", files.slice(1))).toEqual({ entries: 10049, retired: 1 })
    await ingest.remove("ana@example.com", last.id)
    expect(await ingest.catalog.get("ana@example.com", last.id)).toBeUndefined()
  }, 60_000)
})
