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
})

it("**tasks stored before version 14 are indexed on upgrade** and found by their words", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-14-")), "wirecat.db")
  const store = await openStore({ path })
  const service = createTaskService({ store: store.tasks })
  const { task: old } = await service.add(request("1"))
  await store.tasks.edit(old.id, { title: "Renew the parking permit" }, "owner")
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 14)
  expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'task_stems'").all()).toEqual([])
  database.close()

  const upgraded = await openStore({ path })
  const { task } = await createTaskService({ store: upgraded.tasks }).add(request("2"))
  await upgraded.tasks.edit(task.id, { title: "Parking permit renewal" }, "owner")
  const found = await upgraded.tasks.similar({ task: task.id })
  expect(found).toMatchObject([{ ref: `task:${old.id}`, foundBy: ["text"] }])
  await upgraded.close()
})
