import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createTaskService, type NewTask } from "../tasks/index.js"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const request = (message: string): NewTask => ({
  source: `msg:telegram/100/1/${message}`,
  sourceKind: "message",
  account: "telegram:100",
  group: "1",
  kind: "request",
  origin: "agent",
  category: "money",
})

it("**a store from before version 15 keeps its tasks** and records pairs after the upgrade", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-15-")), "wirecat.db")
  const store = await openStore({ path })
  const service = createTaskService({ store: store.tasks })
  const { task: kept } = await service.add(request("1"))
  const { task: dup } = await service.add(request("2"))
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 15)
  expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'task_pairs'").all()).toEqual([])
  database.close()

  const upgraded = await openStore({ path })
  const { pair } = await upgraded.tasks.merge(dup.id, kept.id, "owner")
  expect(pair).toMatchObject({ decision: "merged", other: { ref: `task:${kept.id}` } })
  await upgraded.close()
})
