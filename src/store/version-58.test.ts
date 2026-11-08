import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("gives an older file the enrichments table, empty, and deletes a record's enrichment with the record", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-58-")), "wirecat.db")
  const store = await openStore({ path })
  const note = await store.notes.addNote({ text: "the hosting agreement renews in March" })
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 58)
  expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'enrichments'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  const [candidate] = (await upgraded.enrichment?.pending(10)) ?? []
  expect(candidate).toMatchObject({ type: "note", id: Number(note.id) })
  await upgraded.enrichment?.save([
    {
      type: "note",
      id: Number(note.id),
      hash: String(candidate?.hash),
      provider: "openai",
      model: "m",
      text: "x",
      tokens: 1,
    },
  ])
  expect(await upgraded.enrichment?.counts()).toMatchObject({ records: 1, enriched: 1 })
  await upgraded.close()

  const raw = await openCache(path)
  raw.prepare("DELETE FROM notes WHERE id = ?").run(Number(note.id))
  expect(raw.prepare("SELECT count(*) AS n FROM enrichments").get()?.n).toBe(0)
  raw.close()
})
