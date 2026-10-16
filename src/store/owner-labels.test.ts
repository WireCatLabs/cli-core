import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { searchNotesQuery } from "../services/notes-search.js"
import { createTaskService } from "../tasks/index.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const telegram: AccountKey = { provider: "telegram", account: "500" }
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const open = async (path = join(mkdtempSync(join(tmpdir(), "owner-labels-")), "store.db")) => {
  const store = await openStore({ path })
  live.push(store)
  return { store, path }
}

const fileNote = async (store: MessageStore, folderId: string, path: string) =>
  (await store.notes.saveFileNote({ folderId, path, title: path, text: `about ${path}` })).note

const tagged = async (store: MessageStore, tag: string) =>
  (await searchNotesQuery(store, { text: `tag:${tag}`, limit: 20, timezone: "UTC" })).items
    .map(({ note }) => note.path)
    .sort()

describe("labels that belong to no account", () => {
  it("labels a person, an entity and a task without naming an account, and relates them", async () => {
    const { store } = await open()
    await store.accounts.saveAccount(telegram, { name: null })
    await store.people.savePeople(telegram, [{ id: "101", name: "Rin Synthetic" }])
    const person = await store.people.personOf({ provider: "telegram", id: "101" })
    const organization = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Studio" })
    const task = (
      await createTaskService({ store: store.tasks }).add({
        source: "msg:telegram/500/7/42",
        sourceKind: "message",
        account: "telegram:500",
        group: "7",
        kind: "request",
        origin: "owner",
      })
    ).task

    for (const target of [
      { type: "person" as const, id: person?.uid as string },
      { type: "organization" as const, id: organization.id },
      { type: "task" as const, id: task.id },
    ]) {
      expect(await store.knowledge.addTags(null, target, ["Client"])).toEqual(["client"])
      expect(await store.knowledge.tags(null, target)).toEqual(["client"])
      expect(await store.knowledge.tags(telegram, target)).toEqual(["client"])
    }
    const relation = await store.knowledge.relate(null, {
      from: `person:${person?.uid}`,
      to: organization.ref,
      kind: "member-of",
    })
    expect(await store.knowledge.relations(null, organization.ref)).toEqual([relation])
    expect((await store.knowledge.organizations()).map(({ id }) => id)).toEqual([organization.id])
  })

  it("still needs the account for a chat or a contact", async () => {
    const { store } = await open()
    await expect(store.knowledge.addTags(null, { type: "chat", id: "7" }, ["x"])).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(store.knowledge.addTags(null, { type: "contact", id: "101" }, ["x"])).rejects.toMatchObject({
      code: "validation_error",
    })
  })

  it("looks a person up by the uid a person: reference holds", async () => {
    const { store } = await open()
    await store.accounts.saveAccount(telegram, { name: null })
    await store.people.savePeople(telegram, [{ id: "101", name: "Rin Synthetic" }])
    const person = await store.people.personOf({ provider: "telegram", id: "101" })
    expect(await store.people.personByUid(person?.uid as string)).toEqual(person)
    expect(await store.people.personByUid("nobody")).toBeUndefined()
  })
})

describe("a note's tags remember who stated them", () => {
  it("replaces a file's tags on import and keeps the owner's, even one the file drops", async () => {
    const { store } = await open()
    const folder = await store.notes.addFolder({ name: "Vault" })
    const note = await fileNote(store, folder.id, "plan.md")

    await store.notes.replaceFileTags(note.id, ["budget", "review"])
    await store.knowledge.addTags(null, { type: "document", id: note.id }, ["review", "mine"])
    expect(await store.notes.noteTags(note.ref)).toEqual([
      { tag: "budget", origin: "file" },
      { tag: "mine", origin: "owner" },
      { tag: "review", origin: "owner" },
    ])

    await store.notes.replaceFileTags(note.id, ["budget"])
    await store.notes.replaceFileTags(note.id, [])
    expect(await store.notes.noteTags(note.ref)).toEqual([
      { tag: "mine", origin: "owner" },
      { tag: "review", origin: "owner" },
    ])
  })
})

describe("labels on a notes folder or subfolder", () => {
  it("rejects a name an old store's file still carries, as not found", async () => {
    const { store } = await open()
    await expect(
      store.knowledge.addTags(null, { type: "note", id: "01J0000000000000000000000" }, ["x"]),
    ).rejects.toMatchObject({
      code: "not_found",
    })
    expect(await store.knowledge.tags(null, { type: "person", id: "P1" })).toEqual([])
  })

  it("labels every note under the subfolder, at any depth, and none beside it", async () => {
    const { store } = await open()
    const folder = await store.notes.addFolder({ name: "Vault" })
    for (const path of ["Projects/a.md", "Projects/deep/b.md", "Projects-old/c.md", "d.md"])
      await fileNote(store, folder.id, path)

    await store.knowledge.addTags(null, { type: "folder", id: folder.id, path: "/Projects/" }, ["work"])
    expect(await tagged(store, "work")).toEqual(["Projects/a.md", "Projects/deep/b.md"])

    await store.knowledge.addTags(null, { type: "folder", id: folder.id }, ["vault"])
    expect(await tagged(store, "vault")).toEqual(["Projects-old/c.md", "Projects/a.md", "Projects/deep/b.md", "d.md"])

    await store.knowledge.removeTags(null, { type: "folder", id: folder.id, path: "Projects" }, ["work"])
    expect(await tagged(store, "work")).toEqual([])
  })

  it("lists labelled notes and folders with where each label came from", async () => {
    const { store } = await open()
    const folder = await store.notes.addFolder({ name: "Vault" })
    const note = await fileNote(store, folder.id, "Projects/a.md")
    await store.notes.replaceFileTags(note.id, ["budget"])
    await store.knowledge.addTags(null, { type: "folder", id: folder.id, path: "Projects" }, ["work"])

    const all = await store.knowledge.labelled(null)
    expect(all.items.map(({ target, labels }) => ({ target, labels }))).toEqual([
      { target: { type: "document", id: note.id }, labels: [{ tag: "budget", origin: "file" }] },
      { target: { type: "folder", id: folder.id, path: "Projects" }, labels: [{ tag: "work", origin: "owner" }] },
    ])
    expect((await store.knowledge.labelled(null, { type: "folder" })).items).toHaveLength(1)
    expect((await store.knowledge.labelled(null, { tag: "budget" })).items).toHaveLength(1)
  })
})
