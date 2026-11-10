import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const TG = { provider: "telegram", account: "1" }

it("works out a version 61 file's kinds on the first list and keeps them", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-62-")), "wirecat.db")
  const seeded = await openStore({ path })
  await seeded.people.savePeople(TG, [
    { id: "7", name: "Vera" },
    { id: "8", name: "Harbour Bank" },
  ])
  await seeded.close()
  const old = await openCache(path)
  rollBackTo(old, 62)
  expect(old.prepare("SELECT name FROM pragma_table_info('persons') WHERE name = 'kind'").all()).toEqual([])
  old.close()

  const store = await openStore({ path })
  const db = await openCache(path)
  try {
    expect(db.prepare("SELECT count(*) AS n FROM persons WHERE kind IS NOT NULL").get()?.n).toBe(0)
    expect(await store.people.counts()).toMatchObject({ organization: 1, stranger: 1 })
    expect(db.prepare("SELECT name, kind FROM persons WHERE name IS NOT NULL ORDER BY id").all()).toEqual([
      { name: "Vera", kind: "stranger" },
      { name: "Harbour Bank", kind: "organization" },
    ])
  } finally {
    db.close()
    await store.close()
  }
})
