import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("upgrades schema 2 aliases additively and keeps person aliases independent of vocabulary uniqueness", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "schema-3-vocabulary-")), "fixture.db")
  const old = await openCache(path)
  try {
    migrate(old, { migrations: MIGRATIONS.filter((migration) => migration.version <= 2), now: () => 3000 })
    old
      .prepare(
        "INSERT INTO projects (key,name,type,scope,created_at,updated_at) VALUES ('HARBOUR','Harbour Example','work','work',3000,3000)",
      )
      .run()
    old
      .prepare(
        "INSERT INTO identities (provider,external_id,name,created_at,updated_at) VALUES ('example','AliceExample','Alice Example',3000,3000)",
      )
      .run()
    const alias = old.prepare(
      "INSERT INTO aliases (aliasable_type,aliasable_id,name,name_folded,source,created_at,updated_at) VALUES (?,1,?,?,'owner',3000,3000)",
    )
    alias.run("project", "Short Harbour", "short harbour")
    alias.run("identity", "Alice Example", "alice example")
    alias.run("identity", "ALICE EXAMPLE", "alice example")
    expect(old.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version).toBe(2)
  } finally {
    old.close()
  }
  const current = await openStore({ path, now: () => 4000 })
  try {
    expect(await current.knowledge.resolveVocabulary("SHORT HARBOUR", { kind: "project" })).toMatchObject({
      ambiguous: false,
      matches: [{ id: "1", name: "Harbour Example" }],
    })
    expect(await current.knowledge.addVocabularyAlias({ kind: "project", id: "1" }, "Short Harbour")).toMatchObject({
      changed: false,
    })
  } finally {
    await current.close()
  }
  const upgraded = await openCache(path)
  try {
    expect(upgraded.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version).toBe(3)
    expect(upgraded.prepare("SELECT min_compatible FROM schema_migrations WHERE version=3").get()?.min_compatible).toBe(
      1,
    )
    expect(upgraded.prepare("SELECT count(*) AS count FROM aliases WHERE aliasable_type='identity'").get()?.count).toBe(
      2,
    )
    expect(() =>
      upgraded
        .prepare(
          "INSERT INTO aliases (aliasable_type,aliasable_id,name,name_folded,source,created_at,updated_at) VALUES ('project',1,'SHORT HARBOUR','short harbour','owner',4000,4000)",
        )
        .run(),
    ).toThrow()
    migrate(upgraded, { migrations: MIGRATIONS.filter((migration) => migration.version <= 2), now: () => 5000 })
    expect(upgraded.prepare("SELECT count(*) AS count FROM aliases").get()?.count).toBe(3)
  } finally {
    upgraded.close()
  }
})
