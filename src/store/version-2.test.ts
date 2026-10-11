import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("moves a memory of kind fact to facts with what points at it, keeps other memories, and copies assignments", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-2-")), "wirecat.db")
  const old = await openCache(path)
  migrate(old, { migrations: MIGRATIONS.filter((migration) => migration.version === 1) })
  old.exec(`INSERT INTO bots (name, kind, created_at, updated_at) VALUES ('digest-writer', 'agent', 1, 1);
    INSERT INTO memories (kind, body, author_type, author_id, model, status, scope, created_at, updated_at)
      VALUES ('fact', 'The review is on Fridays', 'bot', (SELECT id FROM bots WHERE name = 'digest-writer'),
        'synthetic-model-1', 'confirmed', 'work', 10, 20),
      ('fact', 'The review was on Mondays', 'person', 1, NULL, 'superseded', 'work', 5, 15),
      ('summary', 'Reviews move often', 'person', 1, NULL, 'proposed', 'personal', 30, 30);
    INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, created_at, author, updated_at)
      VALUES ('memory', 1, 'person', 1, 'evidence', 'suggested', 1, 10, 'agent', 10),
      ('memory', 3, 'memory', 1, 'created-from', 'suggested', 1, 30, 'agent', 30);
    INSERT INTO notes (notable_type, notable_id, body, created_at, updated_at)
      VALUES ('memory', 1, 'Bob Sample confirmed it', 40, 40);
    INSERT INTO projects (key, name, type, scope, tasks_count, status, created_at, updated_at)
      VALUES ('LH', 'Lighthouse', 'work', 'work', 1, 'active', 1, 1);
    INSERT INTO tasks (project_id, number, key, title, type, status, author_type, author_id, source, created_at, updated_at)
      VALUES (1, 1, 'LH-1', 'Review the plan', 'chore', 'open', 'person', 1, 'owner', 1, 1);
    INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, created_at, author, updated_at)
      VALUES ('task', 1, 'person', 1, 'assigned-to', 'owner', 1, 50, 'owner', 60),
      ('task', 1, 'person', 1, 'assigned-to', 'owner', 1, 70, 'owner', 70),
      ('task', 1, 'person', 999, 'assigned-to', 'owner', 1, 80, 'owner', 80);`)
  old.close()

  const store = await openStore({ path })
  try {
    const [fact] = await store.facts.list()
    expect(fact).toMatchObject({
      type: "fact",
      statement: "The review is on Fridays",
      status: "accepted",
      author: { type: "bot" },
      model: "synthetic-model-1",
      confirmedBy: { type: "person" },
      scope: "work",
      source: "memory",
      evidence: ["person:1"],
    })
    expect(await store.facts.list()).toHaveLength(1)
    expect((await store.memories.list()).map(({ body }) => body)).toEqual(["Reviews move often"])
    await expect(store.memories.get("memory:1")).rejects.toMatchObject({ code: "not_found" })
    expect((await store.notes.links({ to: fact?.ref as string })).map((link) => link.from)).toEqual(["memory:3"])
  } finally {
    await store.close()
  }
  const db = await openCache(path)
  const superseded = db.prepare("SELECT status, deleted_at FROM facts WHERE statement LIKE '%Mondays'").get()
  expect(superseded).toMatchObject({ status: "accepted", deleted_at: 15 })
  expect(db.prepare("SELECT notable_type, notable_id FROM notes").get()).toMatchObject({
    notable_type: "fact",
    notable_id: 1,
  })
  expect(
    db.prepare("SELECT task_id, assignee_type, assignee_id, role, created_at FROM task_assignments").all(),
  ).toEqual([{ task_id: 1, assignee_type: "person", assignee_id: 1, role: "assignee", created_at: 50 }])
  expect(db.prepare("SELECT count(*) AS n FROM links WHERE kind = 'assigned-to'").get()?.n).toBe(3)
  db.close()
})
