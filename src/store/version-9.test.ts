import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const account: AccountKey = { provider: "telegram", account: "100" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const unfolded = async (path: string) => {
  const database = await openCache(path)
  try {
    return database
      .prepare(
        `SELECT 'attachments' AS t, name AS v FROM attachments WHERE name IS NOT NULL AND name_folded IS NULL
         UNION ALL SELECT 'tasks', title FROM tasks WHERE title IS NOT NULL AND title_folded IS NULL`,
      )
      .all()
  } finally {
    database.close()
  }
}

/** What a build from before version 8 writes into a store a newer one migrated: the names, no folded copies. */
const writtenByAnOlderBuild = async (path: string) => {
  const store = await openStore({ path })
  await store.saveChats(account, [
    { id: "1", title: "Chat", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  const project = await store.knowledge.addProject({ name: "Research Example", key: "RES", scope: "work" })
  await store.tasks.create({ project: project.ref, title: "placeholder", type: "chore" }, "owner")
  await store.close()
  const old = await openCache(path)
  try {
    old.exec(`INSERT INTO attachments (attachable_type, attachable_id, position, kind, name, created_at, updated_at)
      VALUES ('message', 999, 0, 'file', 'ОТЧЁТ Café.pdf', 0, 0)`)
    old.exec("UPDATE tasks SET title = 'Купить КОФЕ', title_folded = NULL")
  } finally {
    old.close()
  }
}

it("**fills on open the copies an older build left empty**, after migration 8 ran", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "folded-fill-")), "wirecat.db")
  await writtenByAnOlderBuild(path)
  expect(await unfolded(path)).toHaveLength(2)

  opened.push(await openStore({ path }))
  expect(await unfolded(path)).toEqual([])
  const database = await openCache(path)
  try {
    expect(database.prepare("SELECT name_folded FROM attachments WHERE attachable_id = 999").get()).toEqual({
      name_folded: "отчет cafe.pdf",
    })
    expect(database.prepare("SELECT title_folded FROM tasks").get()).toEqual({ title_folded: "купить кофе" })
  } finally {
    database.close()
  }
})

it("adds the indexes that make an open with nothing to fill one probe per column", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-9-")), "wirecat.db")
  await writtenByAnOlderBuild(path)
  const old = await openCache(path)
  rollBackTo(old, 9)
  old.close()

  opened.push(await openStore({ path }))
  expect(await unfolded(path)).toEqual([])
  const database = await openCache(path)
  try {
    const plan = database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM attachments WHERE local_path IS NOT NULL AND local_path_folded IS NULL LIMIT 1",
      )
      .all()
      .map((row) => String(row.detail))
    expect(plan.join(" ")).toContain("attachments_local_path_to_fold")
  } finally {
    database.close()
  }
})
