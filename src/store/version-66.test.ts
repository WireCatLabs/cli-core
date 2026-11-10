import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const TG = { provider: "telegram", account: "1" }

it("clears the kinds of nameless people once, and works one out again when an account's name changes", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-66-")), "wirecat.db")
  const first = await openStore({ path })
  await first.people.savePeople(TG, [{ id: "1", name: "Me" }])
  await first.people.linkToOwner({ provider: "telegram", id: "1" })
  await first.people.savePeople(TG, [{ id: "7", name: null, username: "xorlov" }])
  await first.close()
  const old = await openCache(path)
  // Version 62's trigger, which reads every column of an identity but its name.
  old.exec(
    "DROP TRIGGER person_kind_identity_au; CREATE TRIGGER person_kind_identity_au AFTER UPDATE OF provider, " +
      "external_id, username, phone, email, bot ON identities WHEN OLD.username IS NOT NEW.username BEGIN " +
      "UPDATE persons SET kind = NULL WHERE kind IS NOT NULL AND id IN " +
      "(SELECT person_id FROM identity_links WHERE identity_id = NEW.id); END;",
  )
  old.exec("UPDATE persons SET kind = 'stranger' WHERE kind IS NULL")
  rollBackTo(old, 66)
  old.close()

  const store = await openStore({ path })
  try {
    const cleared = await openCache(path)
    const nameless = cleared
      .prepare("SELECT count(*) AS n FROM persons WHERE kind IS NOT NULL AND trim(coalesce(name, '')) = ''")
      .get()?.n
    cleared.close()
    expect(nameless).toBe(0)
    await store.people.list({ limit: 50, kind: "all" })
    const database = await openCache(path)
    try {
      const kindOf = () =>
        database
          .prepare(
            "SELECT p.kind FROM persons p JOIN identity_links l ON l.person_id = p.id JOIN identities i " +
              "ON i.id = l.identity_id WHERE i.external_id = '7'",
          )
          .get()?.kind
      expect(kindOf()).not.toBeNull()
      database.prepare("UPDATE identities SET name = 'Ярослав Орлов' WHERE external_id = '7'").run()
      expect(kindOf()).toBeNull()
    } finally {
      database.close()
    }
  } finally {
    await store.close()
  }
})
