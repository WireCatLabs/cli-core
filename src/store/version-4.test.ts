import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("keeps a task made before version 4 with no next check, and lets one be set", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-4-")), "wirecat.db")
  const old = await openCache(path)
  migrate(old, { migrations: MIGRATIONS.filter((migration) => migration.version < 4) })
  old.exec(`INSERT INTO projects (key, name, type, scope, tasks_count, status, created_at, updated_at)
      VALUES ('LH', 'Lighthouse', 'work', 'work', 1, 'active', 1, 1);
    INSERT INTO tasks (project_id, number, key, title, type, status, due_at, author_type, author_id, source, created_at, updated_at)
      VALUES (1, 1, 'LH-1', 'Send the token', 'chore', 'open', 500, 'person', 1, 'owner', 1, 1);`)
  old.close()

  const store = await openStore({ path })
  try {
    expect(await store.tasks.details("LH-1")).toMatchObject({ dueAt: new Date(500).toISOString(), nextCheckAt: null })
    const checked = await store.tasks.edit("LH-1", { nextCheckAt: new Date(1_000) }, "owner")
    expect(checked.nextCheckAt).toBe(new Date(1_000).toISOString())
    expect((await store.tasks.events("LH-1")).map(({ kind }) => kind)).toEqual(["next-check"])
  } finally {
    await store.close()
  }
})
