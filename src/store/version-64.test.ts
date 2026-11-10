import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const TRIGGERS = [
  "person_kind_deal_link_ai",
  "person_kind_deal_link_ad",
  "person_kind_deal_link_au",
  "person_kind_deal_owner_moved_au",
  "person_kind_deal_owner_person_au",
]

/** Each lookup of `links` inside the trigger, with the row it fires on written as constants, as SQLite plans it. */
const plans = (database: CacheDatabase, trigger: string): string[] => {
  const body = String(database.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(trigger)?.sql)
  const lookups = [...body.matchAll(/\(SELECT (?:d\.to_id|1) FROM links [\s\S]*?(?=\)(?:;| BEGIN))/g)].map(([found]) =>
    found.slice(1).replace(/\b(?:OLD|NEW)\.(\w+)/g, (_, column: string) => (/type$/.test(column) ? "'deal'" : "1")),
  )
  expect(lookups.length).toBeGreaterThan(0)
  return lookups.flatMap((lookup) =>
    database
      .prepare(`EXPLAIN QUERY PLAN ${lookup}`)
      .all()
      .map((row) => String(row.detail)),
  )
}

it("gives a version 63 file deal-link triggers that find a deal's people by the deal, not by every person link", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-64-")), "wirecat.db")
  await (await openStore({ path })).close()
  const old = await openCache(path)
  // Version 63's lookup: SQLite reads it through the covering index of every link to a person.
  old.exec(
    "DROP TRIGGER person_kind_deal_link_ad; CREATE TRIGGER person_kind_deal_link_ad AFTER DELETE ON links " +
      "WHEN OLD.from_type IN ('deal', 'lead') BEGIN UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN " +
      "(SELECT d.to_id FROM links d WHERE d.from_type = OLD.from_type AND d.from_id = OLD.from_id " +
      "AND d.kind = 'related-to' AND d.to_type = 'person' UNION SELECT OLD.to_id); END;",
  )
  expect(plans(old, "person_kind_deal_link_ad").join("\n")).toMatch(/links_by_to_type_to_id \(to_type=\?\)/)
  rollBackTo(old, 64)
  old.close()

  await (await openStore({ path })).close()
  const database = await openCache(path)
  try {
    for (const trigger of TRIGGERS) {
      const used = plans(database, trigger)
      expect(used.join("\n"), trigger).not.toMatch(/SCAN [a-z]+$|links_by_to_type_to_id \(to_type=\?\)$/m)
    }
  } finally {
    database.close()
  }
})
