import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("keeps an older build's memories, with no project, and lets them take one", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-43-")), "wirecat.db")
  const store = await openStore({ path })
  const project = await store.knowledge.addProject({ name: "Lighthouse", type: "work" })
  const note = await store.notes.addNote({ text: "Synthetic evidence" })
  const memory = await store.memories.add({
    kind: "summary",
    body: "An older memory",
    scope: "work",
    evidence: [note.ref],
    author: "owner",
  })
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 43)
  expect(old.prepare("SELECT name FROM pragma_table_info('memories') WHERE name = 'project_id'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  try {
    expect(await upgraded.memories.get(memory.ref)).toMatchObject({ body: "An older memory", project: null })
    expect(await upgraded.memories.update(memory.ref, { project: project.ref })).toMatchObject({
      projectName: "Lighthouse",
    })
  } finally {
    await upgraded.close()
  }
})
