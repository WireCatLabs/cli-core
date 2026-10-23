import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import type { CacheDatabase } from "../store/driver.js"
import { openCache } from "../store/open.js"
import { type MessageStore, openStore } from "../store/store.js"
import { preparationFixture } from "../testing/meeting-preparation.js"
import { PREPARE_BYTES, personPreparation } from "./person-preparation.js"

const tg = { provider: "telegram", account: "500" }
const otherTg = { provider: "telegram", account: "501" }
const max = { provider: "max", account: "900" }

const chat = (id: string, kind: Chat["kind"], title: string): Chat => ({
  id,
  title,
  kind,
  unreadCount: 0,
  lastMessageAt: "2026-09-03T12:00:00.000Z",
  participantsCount: null,
})

const message = (
  chatId: string,
  id: string,
  senderId: string,
  text: string,
  extra: Partial<Message> = {},
): Message => ({
  id,
  chatId,
  senderId,
  senderName: null,
  timestamp: `2026-09-02T10:0${id}:00.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})

let store: MessageStore
let db: CacheDatabase
let uid: string

const bindProject = async (name: string, key: { provider: string; account: string }) => {
  const project = await store.knowledge.addProject({ name })
  const account = await store.accounts.storedAccount(key)
  db.prepare("UPDATE projects SET account_id=? WHERE id=?").run(account.id, Number(project.id))
  return project
}

beforeEach(async () => {
  const path = join(mkdtempSync(join(tmpdir(), "person-preparation-")), "m.db")
  store = await openStore({ path })
  db = await openCache(path)
  for (const [key, chatId, last] of [
    [tg, "11", message("11", "2", "11", "can you send the draft?")],
    [otherTg, "11", message("11", "2", "11", "seen only by the other account")],
    [max, "m1", message("m1", "2", "900", "direction unknown", { outgoing: null })],
  ] as const) {
    await store.chats.saveChats(key, [chat(chatId, "dialog", "Ana")])
    await store.people.savePeople(key, [{ id: chatId === "m1" ? "m5" : "11", name: "Ana" }])
    await store.messages.saveMessages(
      key,
      chatId,
      [message(chatId, "1", key.account, "hello", { outgoing: true }), last],
      {
        via: "test",
      },
    )
    await store.roster.saveMembers(key, chatId, [chatId === "m1" ? "m5" : "11", key.account])
  }
  const person = await store.people.linkIdentities(
    { provider: "telegram", id: "11" },
    { provider: "max", id: "m5" },
    { method: "manual", by: "owner" },
  )
  uid = person.uid
})

afterEach(async () => {
  db.close()
  await store.close()
})

describe("contacts context --prepare", () => {
  it("lists the one-to-one chats where their message is the newest, only in the accounts the brief reads", async () => {
    const found = await personPreparation(store, tg, "11")
    expect(found.prepare.waiting.map((one) => [one.provider, one.account, one.message.text])).toEqual([
      ["telegram", "500", "can you send the draft?"],
    ])
    expect(found.prepare.coverage.waiting.rule).toMatch(/newest the store holds/)
  })

  it("brings accepted facts about them and their projects, never a project bound to another account", async () => {
    const shared = await store.knowledge.addProject({ name: "Harbour Example" })
    const foreign = await bindProject("Other account work", otherTg)
    for (const project of [shared, foreign])
      await store.knowledge.relate(null, { from: `person:${uid}`, to: project.ref, kind: "member-of", confirmed: true })
    const add = (statement: string, subject: string, project?: string) =>
      store.facts.add({ type: "fact", statement, subject, ...(project ? { project } : {}), by: "owner" })
    await add("Prefers written examples", `person:${uid}`)
    await add("Launch is in November", shared.ref)
    await add("Other account deadline", foreign.ref)
    await add("Leads the other account's work", `person:${uid}`, foreign.ref)
    const proposed = await add("Not accepted yet", `person:${uid}`)
    db.prepare("UPDATE facts SET status='proposed' WHERE id=?").run(Number(proposed.id))

    const found = await personPreparation(store, tg, "11")
    expect(found.prepare.facts.map((fact) => fact.statement).sort()).toEqual([
      "Launch is in November",
      "Prefers written examples",
    ])
  })

  it("brings your notes about them and their open tasks of this account or of no account", async () => {
    await store.notes.addNote({ text: "Asked about the invoice", about: [`person:${uid}`] })
    const shared = await store.knowledge.addProject({ name: "Harbour Example" })
    const own = await bindProject("This account inbox", tg)
    const foreign = await bindProject("Other account inbox", otherTg)
    for (const [project, title] of [
      [shared, "Review the draft"],
      [own, "Answer about the invoice"],
      [foreign, "Other account task"],
    ] as const) {
      const task = await store.tasks.create({ project: project.ref, title, type: "chore" }, "owner")
      await store.tasks.assign(task.ref, { to: `person:${uid}`, role: "assignee" }, "owner")
    }

    const found = await personPreparation(store, tg, "11")
    expect(found.prepare.notes.map((note) => note.text)).toEqual(["Asked about the invoice"])
    expect(found.prepare.tasks.map((task) => task.title).sort()).toEqual([
      "Answer about the invoice",
      "Review the draft",
    ])
    expect(found.prepare.coverage.tasks.accounts.sort()).toEqual(["max:900", "telegram:500"])
  })

  it("cuts the sections at the byte budget and says so", async () => {
    for (let n = 0; n < 3; n++) {
      const fact = await store.facts.add({ type: "fact", statement: "long", subject: `person:${uid}`, by: "owner" })
      db.prepare("UPDATE facts SET statement=? WHERE id=?").run("x".repeat(PREPARE_BYTES / 2), Number(fact.id))
    }

    const found = await personPreparation(store, tg, "11")
    expect(found.prepare.facts.length).toBeLessThan(3)
    expect(found.prepare.coverage.facts).toMatchObject({ hasMore: true, cutBy: "bytes" })
  })
})

describe("contacts prepare, meetings", () => {
  it("names their meetings and the meeting account each came from", async () => {
    const f = await preparationFixture()
    try {
      const participant = (await f.store.meetings.preparationContext(f.context)).participants.items[0]?.personUid
      const record = participant ? await f.store.people.personByUid(participant) : undefined
      const identity = record?.identities[0]
      if (!identity) throw new Error("Missing invented participant")
      await f.store.chats.saveChats(tg, [chat("11", "dialog", "Ana")])
      await f.store.people.savePeople(tg, [{ id: "11", name: "Ana" }])
      await f.store.people.linkIdentities({ provider: "telegram", id: "11" }, identity, {
        method: "manual",
        by: "owner",
      })
      f.store.involvements.rebuild()

      const found = await personPreparation(f.store, tg, "11")
      expect(found.prepare.meetings.map((one) => one.reference)).toEqual([
        expect.stringMatching(new RegExp(`^meeting:${f.accountId}/${f.saved.meeting.id}`)),
      ])
      expect(found.prepare.coverage.meetings.accounts).toEqual([`${f.key.provider}:${f.key.account}`])
    } finally {
      await f.close()
    }
  })

  it("leaves your notes out when the profile denies them, and says why", async () => {
    await store.notes.addNote({ text: "Asked about the invoice", about: [`person:${uid}`] })
    const found = await personPreparation(store, tg, "11", { notes: false })
    expect(found.prepare.notes).toEqual([])
    expect(found.prepare.coverage.notes.withheld).toBe("contacts.notes.list")
  })
})
