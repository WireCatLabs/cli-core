import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene, validateQuery } from "@wirecat/cli-base/query"
import { afterEach, describe, expect, it } from "vitest"
import { formatLocator } from "../domain/locator.js"
import { createTaskService } from "../tasks/index.js"
import { ORGANIZATIONS_QUERY, PROJECTS_QUERY, REMINDERS_QUERY } from "./knowledge-query.js"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const key = { provider: "telegram", account: "500" }
const other = { ...key, account: "501" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
/** Two accounts, each with chat 7 and its message 42, written directly: messaging writes are another area. */
const seed = async (path: string, accounts: (typeof key)[]) => {
  const database = await openCache(path)
  for (const account of accounts) {
    const row = database
      .prepare("INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES (?, ?, 0, 0) RETURNING id")
      .get(account.provider, account.account)
    const chat = database
      .prepare(
        "INSERT INTO chats (account_id, external_id, kind, title, created_at, updated_at) VALUES (?, '7', 'group', 'Synthetic', 0, 0) RETURNING id",
      )
      .get(row?.id as number)
    database
      .prepare(
        "INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, normalized_text, normalizer_version, outgoing, " +
          "created_at, source, updated_at) VALUES (?, ?, '42', 0, 'Source budget plan', 'source budget plan', 1, 1, 0, 'test', 0)",
      )
      .run(chat?.id as number, row?.id as number)
  }
  // As if already stemmed: filling stems on reopen is the messaging area's.
  database.exec("DELETE FROM message_stems_pending")
  database.close()
}
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "knowledge-")), "store.db")
  let clock = Date.parse("2026-10-08T10:00:00Z")
  const store = await openStore({ path, now: () => clock })
  opened.push(store)
  await seed(path, [key, other])
  const locator = formatLocator({ ...key, chat: "7", message: "42" })
  const target = { type: "message" as const, locator }
  const tasks = createTaskService({ store: store.tasks, now: () => new Date(clock) })
  const task = (
    await tasks.add({
      source: locator,
      sourceKind: "message",
      account: `${key.provider}:${key.account}`,
      group: "7",
      kind: "request",
      origin: "owner",
    })
  ).task
  return {
    store,
    path,
    locator,
    target,
    tasks,
    task,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe("cross-source knowledge metadata", () => {
  it("shares contact annotations with existing private note commands and preserves their IDs", async () => {
    const f = await fixture()
    await f.store.people.savePeople(key, [{ id: "101", name: "Rin Synthetic" }])
    const legacy = await f.store.people.addContactNote(key, "101", "Existing private note")
    expect(await f.store.knowledge.annotation(key, legacy.id)).toMatchObject({
      target: { type: "contact", id: "101" },
      text: legacy.text,
    })
    const newer = await f.store.knowledge.addAnnotation(key, { type: "contact", id: "101" }, "New owner note")
    expect((await f.store.people.privateContact(key, "101")).notes.map((note) => note.id).sort()).toEqual(
      [legacy.id, newer.id].sort(),
    )
    expect(await f.store.people.editContactNote(key, "101", newer.id, "Edited through existing API", 1)).toMatchObject({
      revision: 2,
    })
    expect(await f.store.knowledge.editAnnotation(key, legacy.id, "Edited through Memo API", 1)).toMatchObject({
      revision: 2,
    })
    expect((await f.store.knowledge.annotations(key, { target: { type: "contact", id: "101" } })).items).toHaveLength(2)
    await f.store.people.removeContactNote(key, "101", newer.id)
    await f.store.knowledge.removeAnnotation(key, legacy.id)
    expect((await f.store.people.privateContact(key, "101")).notes).toEqual([])
    expect(await f.store.knowledge.taskIds(key, { sources: [f.locator], state: "open", limit: 1 })).toEqual({
      items: [f.task.id],
      hasMore: false,
    })
    await expect(f.store.knowledge.taskIds(key, { limit: 0 })).rejects.toMatchObject({ code: "validation_error" })
    await f.store.knowledge.addTags(key, f.target, ["budget"])
    expect(await f.store.tags.tags(key, { tag: "budget" })).toHaveLength(1)
  })
  it("retains multiple revisioned user annotations after source deletion and store reopening", async () => {
    const f = await fixture()
    const note = await f.store.knowledge.addAnnotation(key, f.target, "Owner budget assessment")
    await f.store.knowledge.addAnnotation(key, f.target, "Second independent note")
    expect((await f.store.knowledge.annotations(key, { search: "budget", limit: 1 })).items).toEqual([note])
    expect(await f.store.knowledge.annotations(key, { limit: 1 })).toMatchObject({ hasMore: true })
    expect(await f.store.knowledge.annotation(other, note.id)).toEqual(note)
    await expect(f.store.knowledge.addAnnotation(other, f.target, "Wrong account")).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(await f.store.knowledge.editAnnotation(key, note.id, "Updated owner assessment", 1)).toMatchObject({
      revision: 2,
    })
    await expect(f.store.knowledge.editAnnotation(key, note.id, "Stale", 1)).rejects.toMatchObject({
      code: "validation_error",
    })
    const database = await openCache(f.path)
    database.exec("UPDATE messages SET deleted_at = 1 WHERE external_id = '42'")
    database.close()
    expect(await f.store.knowledge.annotation(key, note.id)).toMatchObject({
      text: "Updated owner assessment",
      targetState: "deleted",
    })
    const reopened = await openStore({ path: f.path })
    opened.push(reopened)
    expect(await reopened.knowledge.annotation(key, note.id)).toMatchObject({ targetState: "deleted", revision: 2 })
    await reopened.knowledge.removeAnnotation(key, note.id)
    await expect(reopened.knowledge.annotation(key, note.id)).rejects.toMatchObject({ code: "not_found" })
  })

  it("labels stable tasks and canonical persons without changing source text or identity scope", async () => {
    const f = await fixture()
    const target = { type: "task" as const, id: f.task.id }
    expect(await f.store.knowledge.addTags(key, target, ["Follow-Up", "follow-up"])).toEqual(["follow-up"])
    expect(await f.store.knowledge.addTags(key, target, ["follow-up"])).toEqual([])
    expect(await f.store.knowledge.tags(other, target)).toEqual([])
    expect(await f.store.knowledge.removeTags(key, target, ["follow-up"])).toEqual(["follow-up"])
    await expect(f.store.knowledge.addTags(other, target, ["work"])).rejects.toMatchObject({ code: "not_found" })
    await f.store.people.savePeople(key, [{ id: "101", name: "Rin Synthetic" }])
    const person = await f.store.people.personOf({ provider: key.provider, id: "101" })
    const organization = await f.store.knowledge.addOrganization({ kind: "company", name: "Synthetic Studio" })
    const relation = await f.store.knowledge.relate(key, {
      from: `person:${person?.uid}`,
      to: organization.ref,
      kind: "member-of",
      role: "author",
    })
    expect(await f.store.knowledge.relate(key, { from: relation.from, to: relation.to, kind: "member-of" })).toEqual(
      relation,
    )
    expect(await f.store.knowledge.relations(other)).toEqual([relation])
    expect(await f.store.knowledge.relations(key, relation.from)).toEqual([relation])
    const proposal = await f.store.knowledge.relate(key, {
      from: relation.to,
      to: relation.from,
      kind: "related-to",
      confirmed: false,
      provenance: "synthetic weak rule",
    })
    expect(proposal).toMatchObject({ confirmed: false, confidenceCategory: "weak" })
    expect(await f.store.knowledge.confirmRelation(key, proposal.id)).toMatchObject({
      confirmed: true,
      confidenceCategory: "owner-confirmed",
    })
    await f.store.knowledge.removeRelation(key, proposal.id)
    await f.store.knowledge.removeRelation(key, relation.id)
    expect(await f.store.knowledge.relations(key)).toEqual([])
  })

  it("relates a chat, named with its account, to a project only as its member", async () => {
    const f = await fixture()
    const project = await f.store.knowledge.addProject({ name: "Harbour" })
    const chat = "chat:telegram/500/7"
    const link = await f.store.knowledge.relate(null, {
      from: chat,
      to: project.ref,
      kind: "member-of",
      confirmed: false,
    })
    expect(link).toMatchObject({ from: chat, to: project.ref, kind: "member-of", confirmed: false })
    expect(await f.store.knowledge.confirmRelation(null, link.id)).toMatchObject({ confirmed: true })
    expect(await f.store.knowledge.relations(null, project.ref)).toEqual([expect.objectContaining({ from: chat })])
    expect(await f.store.notes.links({ to: project.ref })).toEqual([
      expect.objectContaining({ from: chat, kind: "member-of", confirmed: true }),
    ])
    const organization = await f.store.knowledge.addOrganization({ kind: "company", name: "Synthetic Studio" })
    for (const [key, input, code] of [
      [null, { from: chat, to: project.ref, kind: "related-to" }, "validation_error"],
      [null, { from: chat, to: organization.ref, kind: "member-of" }, "validation_error"],
      [null, { from: project.ref, to: chat, kind: "member-of" }, "not_found"],
      [other, { from: chat, to: project.ref, kind: "member-of" }, "validation_error"],
      [null, { from: "chat:telegram/500/404", to: project.ref, kind: "member-of" }, "not_found"],
    ] as const)
      await expect(f.store.knowledge.relate(key, input)).rejects.toMatchObject({ code })
  })

  it("leases due reminders, rejects stale receipts, survives restart and cancels closed tasks", async () => {
    const f = await fixture()
    const due = "2026-10-08T09:00:00Z"
    const scheduled = await f.store.knowledge.schedule(key, f.task.id, due, "Europe/Madrid")
    expect(await f.store.knowledge.schedule(key, f.task.id, due, "Europe/Madrid")).toEqual(scheduled)
    await expect(f.store.knowledge.schedule(key, f.task.id, due, "Unknown/Zone")).rejects.toMatchObject({
      code: "validation_error",
    })
    const [first] = await f.store.knowledge.claimReminders(key, { leaseMs: 1000 })
    expect(first).toMatchObject({ state: "leased" })
    expect(await f.store.knowledge.claimReminders(key)).toEqual([])
    f.advance(1001)
    const [retry] = await f.store.knowledge.claimReminders(key)
    expect(retry?.receipt).not.toEqual(first?.receipt)
    await expect(
      f.store.knowledge.acknowledgeReminder(key, scheduled.id, first?.receipt as string),
    ).rejects.toMatchObject({ code: "validation_error" })
    const delivered = await f.store.knowledge.acknowledgeReminder(key, scheduled.id, retry?.receipt as string)
    expect(await f.store.knowledge.acknowledgeReminder(key, scheduled.id, retry?.receipt as string)).toEqual(delivered)
    const reopened = await openStore({ path: f.path })
    opened.push(reopened)
    expect(await reopened.knowledge.claimReminders(key)).toEqual([])
    await f.store.knowledge.snoozeReminder(key, scheduled.id, due, delivered.revision)
    await f.tasks.close(f.task.id, { as: "done", by: "owner" })
    expect((await f.store.knowledge.reminders(key))[0]).toMatchObject({ state: "cancelled" })
    expect(await f.store.knowledge.claimReminders(key)).toEqual([])
  })
})

it("filters knowledge lists in SQL before their 500-row bound", async () => {
  const f = await fixture()
  const db = await openCache(f.path)
  try {
    for (let i = 0; i < 501; i++) {
      db.prepare(
        "INSERT INTO organizations (kind,name,scope,created_at,updated_at) VALUES ('team',?,'personal',0,0)",
      ).run(`A${i}`)
      db.prepare(
        "INSERT INTO projects (key,name,type,scope,created_at,updated_at) VALUES (?,?,'other','personal',0,0)",
      ).run(`sample${i}`, `A${i}`)
    }
  } finally {
    db.close()
  }
  const org = await f.store.knowledge.addOrganization({ kind: "company", name: "Z selected", scope: "work" })
  const project = await f.store.knowledge.addProject({
    key: "TGT",
    name: "Z selected",
    type: "client",
    organization: org.ref,
    scope: "work",
  })
  const orgQuery = parseLucene(`kind:company AND scope:work AND id:${org.id}`)
  validateQuery(orgQuery, ORGANIZATIONS_QUERY)
  expect(await f.store.knowledge.organizations(orgQuery)).toEqual([org])
  const projectQuery = parseLucene(`key:TGT AND type:client AND organization_id:${org.id}`)
  validateQuery(projectQuery, PROJECTS_QUERY)
  expect(await f.store.knowledge.projects(projectQuery)).toEqual([project])
  const due = "2026-10-08T11:00:00.000Z"
  const reminder = await f.store.knowledge.schedule(key, f.task.id, due, "UTC")
  const reminderQuery = parseLucene(`state:pending AND due_at>=2026-10-08 AND revision:1`)
  validateQuery(reminderQuery, REMINDERS_QUERY)
  expect(await f.store.knowledge.reminders(key, reminderQuery)).toEqual([reminder])
  expect(await f.store.knowledge.reminders(other, reminderQuery)).toEqual([])
  await f.store.knowledge.cancelReminder(key, reminder.id)
  expect(await f.store.knowledge.reminders(key, reminderQuery)).toEqual([])
})

it("filters projects by name with wildcards and keeps account task inboxes out unless kind is asked for", async () => {
  const f = await fixture()
  const real = await f.store.knowledge.addProject({ key: "STRT", name: "Smart start", type: "work", scope: "work" })
  const list = async (text?: string) => {
    const query = text === undefined ? undefined : parseLucene(text)
    if (query) validateQuery(query, PROJECTS_QUERY)
    return f.store.knowledge.projects(query)
  }
  expect(await list("name:*tart*")).toEqual([real])
  expect(await list('name:"smart start"')).toEqual([real])
  expect(await list("name:*nothing*")).toEqual([])
  expect(real.kind).toBe("project")
  expect(await list()).toEqual([real])
  expect(await list("scope:personal")).toEqual([])
  const inboxes = await list("kind:inbox")
  expect(inboxes).toMatchObject([{ name: "telegram:500", kind: "inbox" }])
  expect(await list("kind:project")).toEqual([real])
  expect((await list("name:telegram*")).length).toBe(0)
  expect(await list("name:telegram* AND kind:inbox")).toEqual(inboxes)
})
