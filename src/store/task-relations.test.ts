import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "task-graph-test-")), "fixture.db")
  const store = await openStore({ path })
  opened.push(store)
  const project = await store.knowledge.addProject({ name: "Research Example", key: "RES", scope: "work" })
  const a = await store.tasks.create({ project: project.ref, title: "Research draft", type: "feature" }, "owner")
  const b = await store.tasks.create({ project: project.ref, title: "Review draft", type: "chore" }, "owner")
  const c = await store.tasks.create({ project: project.ref, title: "Publish draft", type: "chore" }, "owner")
  return { path, store, project, a, b, c }
}
it("uses short project keys and sequential task keys, while reopening legacy keys unchanged", async () => {
  const { store, path, a, b } = await fixture()
  expect([a.key, b.key]).toEqual(["RES-1", "RES-2"])
  const generated = await store.knowledge.addProject({ name: "Lighthouse Example" })
  expect(generated.key).toBe("LIGH")
  expect((await store.knowledge.addProject({ name: "Lighthouse Another" })).key).toBe("LIG2")
  expect((await store.knowledge.addProject({ name: "X" })).key).toBe("XXX")
  expect((await store.knowledge.addProject({ name: "Пример" })).key).toBe("PRJ")
  for (const key of ["R", "RE", "RESEARCH", "1RES"])
    await expect(store.knowledge.addProject({ name: "Other Example", key })).rejects.toMatchObject({
      code: "validation_error",
    })
  const db = await openCache(path)
  try {
    db.prepare(
      "INSERT INTO projects (key,name,type,scope,created_at,updated_at) VALUES ('LEGACY','Legacy Example','work','work',1,1)",
    ).run()
  } finally {
    db.close()
  }
  const old = await store.tasks.create(
    { project: "LEGACY", title: "Existing project follow-up", type: "chore" },
    "owner",
  )
  expect(old.key).toBe("LEGACY-1")
  const reopened = await openStore({ path })
  opened.push(reopened)
  expect((await reopened.tasks.details(old.key)).key).toBe("LEGACY-1")
})
it("keeps blocking directional, rejects cycles and updates readiness when blockers finish", async () => {
  const { store, a, b, c } = await fixture()
  expect(await store.tasks.linkTask(b.id, a.id, "blocked-by", "owner")).toMatchObject({ changed: true })
  expect(await store.tasks.linkTask(b.id, a.id, "blocked-by", "owner")).toMatchObject({ changed: false })
  await store.tasks.linkTask(c.id, b.id, "blocked-by", "owner")
  await expect(store.tasks.linkTask(a.id, c.id, "blocked-by", "owner")).rejects.toMatchObject({
    details: { reason: "task.dependency-cycle" },
  })
  expect((await store.tasks.readyTasks("RES")).items.map((x) => x.key)).toEqual([a.key])
  expect(await store.tasks.taskReadiness(b.id)).toEqual({ ready: false, blockers: [{ task: a.ref, state: "open" }] })
  await store.tasks.edit(a.id, { status: "done" }, "owner")
  expect((await store.tasks.readyTasks("RES")).items.map((x) => x.key)).toEqual([b.key])
  expect(await store.tasks.taskReadiness(a.id)).toEqual({ ready: false, blockers: [] })
  expect(await store.tasks.unlinkTask(c.id, b.id, "blocked-by", "owner")).toEqual({ changed: true })
  expect(await store.tasks.unlinkTask(c.id, b.id, "blocked-by", "owner")).toEqual({ changed: false })
})
it("keeps related and follow-up links informational, normalizes related pairs, and guards generic writes", async () => {
  const { store, a, b } = await fixture()
  await store.tasks.linkTask(b.id, a.id, "follow-up-of", "owner")
  await expect(store.tasks.linkTask(a.id, b.id, "follow-up-of", "owner")).rejects.toMatchObject({
    code: "validation_error",
  })
  await store.tasks.linkTask(a.id, b.id, "related-to", "owner")
  expect(await store.tasks.linkTask(b.id, a.id, "related-to", "owner")).toMatchObject({ changed: false })
  expect((await store.tasks.taskRelations(a.id)).map((x) => x.kind)).toEqual(["follow-up-of", "related-to"])
  expect(await store.tasks.readyTasks("RES", { limit: 1 })).toMatchObject({ hasMore: true, items: [{ key: a.key }] })
  await expect(store.tasks.linkTask(a.id, a.id, "related-to", "owner")).rejects.toMatchObject({
    code: "validation_error",
  })
  await expect(store.tasks.linkTask(a.id, b.id, "blocked-by", { bot: "planner" })).rejects.toMatchObject({
    code: "permission_error",
  })
  await expect(store.notes.addLink({ from: a.ref, to: b.ref, kind: "blocked-by" })).rejects.toMatchObject({
    code: "validation_error",
  })
  await expect(store.tasks.readyTasks("RES", { limit: 501 })).rejects.toMatchObject({ code: "validation_error" })
})
it("does not make tasks ready when a blocker is deleted", async () => {
  const { store, path, a, b, c } = await fixture()
  await store.tasks.linkTask(b.id, a.id, "blocked-by", "owner")
  const db = await openCache(path)
  try {
    db.prepare("UPDATE tasks SET deleted_at=1 WHERE key=?").run(a.key)
  } finally {
    db.close()
  }
  expect(await store.tasks.taskReadiness(b.id)).toEqual({
    ready: false,
    blockers: [{ task: a.ref, state: "unavailable" }],
  })
  expect((await store.tasks.readyTasks("RES")).items.map((x) => x.key)).toEqual([c.key])
})
it("records link changes once and keeps dismissed blockers unresolved", async () => {
  const { store, a, b } = await fixture()
  await store.tasks.linkTask(b.id, a.id, "blocked-by", "owner")
  await store.tasks.linkTask(b.id, a.id, "blocked-by", "owner")
  await store.tasks.edit(a.id, { status: "dismissed" }, "owner")
  expect(await store.tasks.taskReadiness(b.id)).toEqual({
    ready: false,
    blockers: [{ task: a.ref, state: "dismissed" }],
  })
  await store.tasks.unlinkTask(b.id, a.id, "blocked-by", "owner")
  await store.tasks.unlinkTask(b.id, a.id, "blocked-by", "owner")
  expect((await store.tasks.events(b.id)).map((e) => e.kind)).toEqual(["created", "linked", "unlinked"])
})
it("rolls back failed creation without consuming a project task number", async () => {
  const { store, path } = await fixture()
  await expect(store.tasks.create({ project: "RES", title: "", type: "chore" }, "owner")).rejects.toMatchObject({
    code: "validation_error",
  })
  const other = await openStore({ path })
  opened.push(other)
  const [a, b] = await Promise.all([
    store.tasks.create({ project: "RES", title: "Another Example", type: "chore" }, "owner"),
    other.tasks.create({ project: "RES", title: "Separate Example", type: "chore" }, "owner"),
  ])
  expect([a.key, b.key]).toEqual(["RES-4", "RES-5"])
})
