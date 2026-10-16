import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createTaskService } from "../tasks/index.js"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("**a store from before version 17 keeps its tasks** and takes an agent's close suggestion after the upgrade", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-17-")), "wirecat.db")
  const store = await openStore({ path })
  const { task } = await createTaskService({ store: store.tasks }).add({
    source: "msg:telegram/100/1/1",
    sourceKind: "message",
    account: "telegram:100",
    group: "1",
    kind: "request",
    origin: "agent",
    category: "money",
  })
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 17)
  database.close()

  const upgraded = await openStore({ path })
  expect(await upgraded.tasks.details(task.id)).toMatchObject({ status: "open", closeSuggestion: null })
  await upgraded.tasks.suggestClose(task.id, { as: "done", certainty: 0.5 }, { bot: "codex" })
  expect(await upgraded.tasks.details(task.id)).toMatchObject({ closeSuggestion: { by: "codex", certainty: 0.5 } })
  await upgraded.close()
})
