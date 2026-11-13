import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("adds the facts removal log and a phone call's fields on meetings", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-67-")), "wirecat.db")
  await (await openStore({ path })).close()
  const old = await openCache(path)
  rollBackTo(old, 67)
  const columns = () =>
    old
      .prepare("SELECT name FROM pragma_table_info('meetings') WHERE name IN ('direction', 'client_phone')")
      .all()
      .map(({ name }) => name)
  expect(columns()).toEqual([])
  expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'fact_removals'").get()).toBeUndefined()
  old.close()

  const store = await openStore({ path })
  try {
    const fact = await store.facts.add({ type: "fact", statement: "Kept until removed", by: "owner" })
    await store.facts.remove(fact.ref, "owner", "a mistake")
    expect((await store.facts.removed()).items).toMatchObject([{ fact: fact.ref, reason: "a mistake" }])
    const migrated = await openCache(path)
    expect(
      migrated
        .prepare("SELECT name FROM pragma_table_info('meetings') WHERE name IN ('direction', 'client_phone')")
        .all()
        .map(({ name }) => name),
    ).toEqual(["direction", "client_phone"])
    migrated.close()
  } finally {
    await store.close()
  }
})
