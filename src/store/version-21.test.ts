import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { MIGRATIONS } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("keeps existing document annotations when adding transfer receipts to a schema 20 store", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-21-")), "store.db")
  const original = await openStore({ path })
  const folder = await original.notes.addFolder({ name: "example-documents:synthetic" })
  const { note: document } = await original.notes.saveFileNote({
    folderId: folder.id,
    path: "source.md",
    title: "Source",
    text: "Original evidence",
  })
  const annotation = await original.notes.addNote({ text: "Keep this annotation", about: [document.ref] })
  await original.close()
  const before = await openCache(path)
  rollBackTo(before, 21)
  before.close()
  const upgraded = await openStore({ path })
  try {
    expect(await upgraded.notes.note(document.ref)).toMatchObject({ text: "Original evidence" })
    expect(await upgraded.notes.note(annotation.ref)).toMatchObject({ text: "Keep this annotation" })
  } finally {
    await upgraded.close()
  }
  const after = await openCache(path)
  try {
    expect(after.prepare("SELECT count(*) AS n FROM document_annotation_transfers").get()?.n).toBe(0)
    expect(after.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version).toBe(
      MIGRATIONS.at(-1)?.version,
    )
  } finally {
    after.close()
  }
})
