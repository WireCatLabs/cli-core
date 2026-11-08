import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("marks the persons an older build's merges emptied, following each to the person that holds the identities", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-59-")), "wirecat.db")
  const store = await openStore({ path })
  const named = await store.people.add({ name: "Name Only" })
  await store.crm.savePeople({ provider: "example-crm", account: "portal-a" }, [
    { externalId: "1", name: "Ana", email: "ana@example.com" },
  ])
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 59)
  const ghost = Number(
    old.prepare("SELECT from_person_id AS id FROM identity_link_events WHERE method = 'same-email'").get()?.id,
  )
  const live = Number(old.prepare("SELECT person_id AS id FROM identity_links").all().at(-1)?.id)
  const later = Number(
    old.prepare("INSERT INTO persons (name, created_at, updated_at) VALUES ('Later', 1, 1) RETURNING id").get()?.id,
  )
  // An older build merges the live person on, so the first mark has to be followed to its end.
  old.prepare("UPDATE identity_links SET person_id = ? WHERE person_id = ?").run(later, live)
  old
    .prepare(
      "INSERT INTO identity_link_events (identity_id, from_person_id, to_person_id, method, created_at, author) " +
        "SELECT identity_id, ?, ?, 'manual', 2, 'owner' FROM identity_links WHERE person_id = ?",
    )
    .run(live, later, later)
  old.close()

  const upgraded = await openStore({ path })
  const raw = await openCache(path)
  const marks = raw
    .prepare("SELECT id, merged_into AS target FROM persons WHERE merged_into IS NOT NULL ORDER BY id")
    .all()
  expect(marks.map((row) => [Number(row.id), Number(row.target)])).toEqual([
    [ghost, later],
    [live, later],
  ])
  expect(raw.prepare("SELECT merged_into FROM persons WHERE id = ?").get(Number(named.uid))?.merged_into).toBeNull()
  expect((await upgraded.people.personByUid(String(ghost)))?.uid).toBe(String(later))
  raw.close()
  await upgraded.close()
})
