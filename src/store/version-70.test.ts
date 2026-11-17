import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { resetTrackerItemWords } from "./sqlite/tracker.js"
import { openStore } from "./store.js"

const WORKSPACE = { provider: "example-tracker", account: "workspace" }

it("gives a version 69 file a place for tracker copies, with their words indexed", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-70-")), "wirecat.db")
  const store = await openStore({ path })
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 70)
  expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tracker_items'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  try {
    await upgraded.tracker.save(
      WORKSPACE,
      "issue",
      [{ externalId: "i1", key: "ENG-1", title: "Refund the invoice" }],
      1,
    )
    expect((await upgraded.tracker.find({ words: ["refund"] })).items).toHaveLength(1)
    await upgraded.tracker.save(WORKSPACE, "issue", [{ externalId: "i1", title: "Close the ticket" }], 2)
    expect((await upgraded.tracker.find({ words: ["refund"] })).items).toHaveLength(0)
    expect((await upgraded.tracker.find({ words: ["ticket"] })).items).toHaveLength(1)
  } finally {
    await upgraded.close()
  }

  const database = await openCache(path)
  expect(resetTrackerItemWords(database)).toBe(1)
  database.close()
  const again = await openStore({ path })
  try {
    expect((await again.tracker.find({ words: ["ticket"] })).items).toHaveLength(1)
  } finally {
    await again.close()
  }
})
