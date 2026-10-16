import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { listQuery } from "../cli/list-query.js"
import type { Message } from "../domain/models.js"
import { openStore } from "../store/store.js"
import { storeOnlyDeps } from "./deps.js"
import { TASK_QUERY, type TasksService, tasksService } from "./tasks.js"

const viewed = async (tasks: TasksService, query = "") => {
  const ast = listQuery(query, TASK_QUERY, "tasks list")
  return (await tasks.list({ limit: 100, offset: 0, previews: true, ...(ast ? { query: ast } : {}) })).previews ?? []
}

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const account = { provider: "chat", account: "500" }

it("keeps native note tasks scoped, idempotent and closed, with live previews and no copied text", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "note-tasks-")), "m.db") })
  try {
    const tasks = tasksService(storeOnlyDeps(store, account, { app }))
    const note = await store.notes.addNote({ text: "Synthetic request", title: "A note" })
    const source = note.ref
    const first = await tasks.add(source, "request", "owner")
    expect(first).toMatchObject({
      created: true,
      task: { source, sourceKind: "note", account: "chat:500", message: null, note: { text: "Synthetic request" } },
    })
    expect(await store.tasks.get(first.task.id)).not.toHaveProperty("note")
    await store.notes.editNote(note.id, "Changed request", note.revision)
    expect((await viewed(tasks))[0]?.note?.text).toBe("Changed request")
    expect((await tasks.add(source, "request", "owner")).task.id).toBe(first.task.id)
    await tasks.close(first.task.id, { as: "done", by: "owner" })
    expect(await tasks.add(source, "request", "owner")).toMatchObject({ created: false, task: { state: "done" } })
    const second = tasksService(storeOnlyDeps(store, { ...account, account: "501" }, { app }))
    expect(await viewed(second)).toEqual([])
    await expect(second.close(first.task.id, { as: "done", by: "owner" })).rejects.toMatchObject({ code: "not_found" })
    await store.notes.removeNote(note.id)
    expect((await viewed(tasks, "state:done"))[0]).toMatchObject({ id: first.task.id, message: null, note: null })
    await expect(tasks.add(source, "request", "owner")).rejects.toMatchObject({ code: "not_found" })
    await expect(tasks.add("note:999", "request", "owner")).rejects.toMatchObject({ code: "not_found" })
  } finally {
    await store.close()
  }
})

it("keeps a file task when its source is removed and reads the restored file by stable ID", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "file-tasks-")), "m.db") })
  try {
    const folder = await store.notes.addFolder({ name: "Synthetic" })
    const { note } = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "plan.md",
      title: "Plan",
      text: "Synthetic file",
    })
    const tasks = tasksService(storeOnlyDeps(store, account, { app }))
    const added = await tasks.add(note.ref, "promise", "owner")
    await store.notes.renameFileNote(folder.id, "plan.md", "new.md")
    expect((await viewed(tasks))[0]?.note?.text).toBe("Synthetic file")
    await store.notes.deleteFileNotes(folder.id, ["new.md"])
    expect((await viewed(tasks))[0]?.note).toBeNull()
    await expect(tasks.add(note.ref, "promise", "owner")).rejects.toMatchObject({ code: "not_found" })
    const restored = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "new.md",
      title: "Plan",
      text: "Restored",
    })
    expect(restored.note.id).toBe(note.id)
    expect(await tasks.add(note.ref, "promise", "owner")).toMatchObject({
      created: false,
      task: { id: added.task.id, note: { text: "Restored" } },
    })
  } finally {
    await store.close()
  }
})

it("**links two project tasks as a relation when a target is task:**, a bare id by its kind, and nothing else beside it", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-link-")), "m.db") })
  try {
    const tasks = tasksService(storeOnlyDeps(store, account, { app }))
    const project = await store.knowledge.addProject({ name: "Research Example", key: "RES", scope: "work" })
    const create = (title: string) => store.tasks.create({ project: project.ref, title, type: "chore" }, "owner")
    const a = await create("Draft")
    const b = await create("Review")
    const c = await create("Publish")
    const link = (targets: string[], kind: "blocked-by" | "follow-up-of" | "related-to" | "evidence") =>
      tasks.link(a.id, { references: targets }, { kind, by: "owner" })

    expect(await link([`task:${b.id}`], "blocked-by")).toMatchObject({ relations: [{ kind: "blocked-by" }] })
    await link([c.id], "follow-up-of")
    await link([b.id], "related-to")
    expect((await store.tasks.taskRelations(a.id)).map(({ kind }) => kind).sort()).toEqual([
      "blocked-by",
      "follow-up-of",
      "related-to",
    ])
    await expect(link(["999"], "related-to")).rejects.toThrow("write task:999")
    await expect(link([`task:${b.id}`], "evidence")).rejects.toThrow(
      "blocked-by, follow-up-of, related-to, duplicate-of, discovered-from",
    )
    await expect(link([`task:${b.id}`, "https://example.com/plan"], "related-to")).rejects.toThrow("call of their own")
    await expect(link(["https://example.com/plan"], "blocked-by")).rejects.toThrow("is for a task: target")
    await expect(
      tasks.link(a.id, { references: [`task:${b.id}`] }, { kind: "blocked-by", by: "agent" }),
    ).rejects.toMatchObject({ code: "permission_error" })
  } finally {
    await store.close()
  }
})

it("**a message linked to a task sends the tasks it now looks like to review**; the link stands, nothing merges", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-link-check-")), "m.db") })
  try {
    const said = (id: string, text: string): Message => ({
      id,
      chatId: "7",
      senderId: "9",
      senderName: "Alice Example",
      timestamp: `2026-10-06T10:0${id}:00.000Z`,
      editedAt: null,
      text,
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    })
    await store.saveMessages(
      account,
      "7",
      [
        said("1", "Can you call the plumber?"),
        said("2", "The boiler repair is 15 000 rub"),
        said("3", "x"),
        said("4", "y"),
      ],
      { via: "test" },
    )
    const tasks = tasksService(storeOnlyDeps(store, account, { app }))
    const add = async (message: string, title: string) =>
      (await tasks.add(`msg:chat/500/7/${message}`, "request", "agent", { title, category: "money" }, { new: true }))
        .task
    const plumber = await add("1", "Call the plumber")
    const boiler = await add("3", "Pay 15000 rub for the boiler repair")
    const pairs = () => store.tasks.pairs("chat:500", { decision: "review", limit: 10, offset: 0 })
    expect(await pairs()).toEqual([])

    const linked = await tasks.link(plumber.id, { references: ["msg:chat/500/7/2"] }, { kind: "evidence", by: "agent" })
    expect(linked).toMatchObject({ review: 1, links: [{ kind: "evidence" }] })
    expect(await pairs()).toMatchObject([
      { task: { key: boiler.key }, other: { key: plumber.key }, band: "likely", decision: "review" },
    ])
    expect(
      await tasks.link(plumber.id, { references: ["msg:chat/500/7/2"] }, { kind: "evidence", by: "agent" }),
    ).toMatchObject({ review: 0 })
    expect(
      await tasks.link(plumber.id, { references: ["https://example.com"] }, { kind: "related-to", by: "agent" }),
    ).not.toHaveProperty("review")

    await tasks.close(boiler.id, { as: "done", by: "owner" })
    const other = await add("4", "Pay 15000 rub for the boiler repair again")
    await tasks.close(other.id, { as: "done", by: "owner" })
    expect(
      await tasks.link(other.id, { references: ["msg:chat/500/7/2"] }, { kind: "evidence", by: "agent" }),
    ).toMatchObject({ review: 0 })
    expect(await tasks.show(plumber.id)).toMatchObject({ status: "open" })
  } finally {
    await store.close()
  }
})
