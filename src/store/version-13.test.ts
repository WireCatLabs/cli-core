import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createTaskService, type NewTask } from "../tasks/index.js"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const question: NewTask = {
  source: "msg:telegram/100/1/1",
  sourceKind: "message",
  account: "telegram:100",
  group: "1",
  kind: "question",
  origin: "rule",
}

it("**a store from before version 13 keeps its inbox keys**, and its next task takes a key by type", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-13-")), "wirecat.db")
  const store = await openStore({ path })
  const { task: old } = await createTaskService({ store: store.tasks }).add(question)
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 13)
  database.prepare("UPDATE tasks SET key = 'IN1A2B3C4D-1'").run()
  expect(database.prepare("SELECT name FROM pragma_table_info('tasks') WHERE name = 'claimed_by'").all()).toEqual([])
  database.close()

  const upgraded = await openStore({ path })
  expect(await upgraded.tasks.get("IN1A2B3C4D-1")).toMatchObject({ id: old.id, key: "IN1A2B3C4D-1" })
  expect((await upgraded.tasks.details("IN1A2B3C4D-1")).category).toBeNull()
  const { task } = await createTaskService({ store: upgraded.tasks }).add({
    ...question,
    source: "msg:telegram/100/1/2",
    category: "money",
  })
  expect(await upgraded.tasks.get(task.id)).toMatchObject({ key: "Q-1", category: "money" })
  expect((await upgraded.tasks.claim("Q-1", "codex", new Date(Date.now() + 60_000))).claimedBy).toBe("codex")
  await upgraded.close()
})
