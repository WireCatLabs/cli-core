import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { Chat } from "../domain/models.js"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import type { PeopleSort } from "./sqlite/people-list.js"
import { SMALL_GROUP_MEMBERS } from "./sqlite/person-ties.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const TG: AccountKey = { provider: "telegram", account: "1" }
const MAIL: AccountKey = { provider: "email", account: "me@example.test" }
const NOW = Date.parse("2026-11-01T12:00:00Z")
const SORTS: PeopleSort[] = ["interactions", "recent", "name", "tasks"]

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const opened = async (): Promise<{ store: MessageStore; db: CacheDatabase; path: string }> => {
  const path = join(mkdtempSync(join(tmpdir(), "people-kinds-")), "store.db")
  const store = await openStore({ path })
  handles.push(store)
  await store.people.savePeople(TG, [{ id: "1", name: "Me" }])
  await store.people.linkToOwner({ provider: "telegram", id: "1" })
  const db = await openCache(path)
  handles.push(db)
  return { store, db, path }
}

const chat = (id: string, kind: Chat["kind"], participantsCount: number | null): Chat => ({
  id,
  title: id,
  kind,
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount,
})

const identityPk = (db: CacheDatabase, provider: string, id: string) =>
  Number(db.prepare("SELECT id FROM identities WHERE provider = ? AND external_id = ?").get(provider, id)?.id)

const everyList = async (store: MessageStore) =>
  Promise.all(SORTS.map((sort) => store.people.list({ limit: 100, kind: "all", sort })))

/** What the list says now, from the stored kinds the triggers kept, against the same worked out from nothing. */
const inStep = async (store: MessageStore, db: CacheDatabase) => {
  const kept = await everyList(store)
  db.prepare("UPDATE persons SET kind = NULL").run()
  expect(kept).toEqual(await everyList(store))
}

it("keeps every stored kind, order and count in step with the writes that decide them", async () => {
  const { store, db } = await opened()
  const strangers = Array.from({ length: 12 }, (_, n) => ({ id: String(10 + n), name: `Stranger ${n}` }))
  await store.people.savePeople(TG, strangers)
  await store.accounts.saveAccount(MAIL, { name: null })
  await store.people.savePeople(MAIL, [
    { id: "lena@example.test", name: "Lena Marsh" },
    { id: "otto@example.test", name: "Otto Vale" },
  ])
  const pk = (id: string) => identityPk(db, "telegram", id)
  const tg = Number(db.prepare("SELECT id FROM accounts WHERE provider = 'telegram'").get()?.id)
  const mail = Number(db.prepare("SELECT id FROM accounts WHERE provider = 'email'").get()?.id)
  await inStep(store, db)

  db.prepare("UPDATE persons SET name = 'Weather Notifications' WHERE name = 'Stranger 0'").run()
  await inStep(store, db)

  await store.chats.saveChats(TG, [chat("d", "dialog", 2), chat("g", "group", 20), chat("u", "group", null)])
  await store.roster.saveMembers(TG, "d", ["1", "11"])
  await store.roster.saveMembers(TG, "g", ["1", "12", "13"])
  await store.roster.saveMembers(TG, "u", ["1", "14"])
  await inStep(store, db)

  await store.chats.saveChats(TG, [chat("g", "group", 5)])
  await inStep(store, db)

  const unsized = Number(db.prepare("SELECT id FROM chats WHERE external_id = 'u'").get()?.id)
  db.prepare(
    "INSERT INTO member_counts (chat_id, date, reported_count, listed_count, complete_list, created_at) " +
      "VALUES (?, ?, 4, 4, 1, ?)",
  ).run(unsized, NOW, NOW)
  await inStep(store, db)

  db.prepare("DELETE FROM chat_members WHERE identity_id = ?").run(pk("11"))
  await inStep(store, db)

  const group = Number(db.prepare("SELECT id FROM chats WHERE external_id = 'g'").get()?.id)
  const message = db.prepare(
    "INSERT INTO messages (chat_id, account_id, external_id, sender_identity_id, sent_at, text, created_at, " +
      "updated_at, source) VALUES (?, ?, ?, ?, ?, 'hi', ?, ?, 'sync')",
  )
  message.run(group, tg, "a", pk("12"), NOW + 5, NOW, NOW)
  message.run(group, tg, "b", pk("13"), NOW + 9, NOW, NOW)
  message.run(group, tg, "c", pk("13"), NOW + 1, NOW, NOW)
  await inStep(store, db)

  db.prepare("UPDATE messages SET deleted_at = ? WHERE external_id = 'b'").run(NOW)
  await inStep(store, db)

  db.prepare("DELETE FROM messages WHERE external_id = 'c'").run()
  await inStep(store, db)

  const thread = Number(
    db
      .prepare(
        "INSERT INTO email_threads (account_id, external_id, created_at, updated_at) VALUES (?, 't', ?, ?) RETURNING id",
      )
      .get(mail, NOW, NOW)?.id,
  )
  const email = db.prepare(
    "INSERT INTO emails (account_id, email_thread_id, external_id, from_identity_id, outgoing, sent_at, " +
      "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
  )
  const otto = identityPk(db, "email", "otto@example.test")
  for (const n of [1, 2, 3, 4]) email.run(mail, thread, `o${n}`, otto, 0, NOW + n, NOW, NOW)
  await inStep(store, db)

  db.prepare("DELETE FROM emails WHERE external_id = 'o4'").run()
  await inStep(store, db)

  const bulk = Number(
    db
      .prepare(
        "INSERT INTO mailboxes (account_id, external_id, name, kind, created_at, updated_at) " +
          "VALUES (?, 'memo:bulk', 'bulk', 'inbox', ?, ?) RETURNING id",
      )
      .get(mail, NOW, NOW)?.id,
  )
  const lena = identityPk(db, "email", "lena@example.test")
  const lenaMail = [1, 2, 3].map((n) => Number(email.get(mail, thread, `m${n}`, lena, 0, NOW + n, NOW, NOW)?.id))
  const inBox = db.prepare("INSERT INTO email_mailboxes (email_id, mailbox_id, created_at) VALUES (?, ?, ?)")
  for (const id of lenaMail.slice(1)) inBox.run(id, bulk, NOW)
  await inStep(store, db)

  db.prepare("UPDATE mailboxes SET kind = 'bulk' WHERE id = ?").run(bulk)
  await inStep(store, db)

  db.prepare("DELETE FROM email_mailboxes WHERE email_id = ?").run(lenaMail[1] as number)
  await inStep(store, db)

  for (const id of lenaMail.slice(0, 2)) inBox.run(id, bulk, NOW)
  await inStep(store, db)

  const sent = Number(email.get(mail, thread, "out", null, 1, NOW, NOW, NOW)?.id)
  db.prepare(
    "INSERT INTO email_recipients (email_id, identity_id, address, role, position, created_at, updated_at) " +
      "VALUES (?, ?, 'h@example.test', 'to', 0, ?, ?)",
  ).run(sent, pk("15"), NOW, NOW)
  await inStep(store, db)

  db.prepare("UPDATE emails SET deleted_at = ? WHERE id = ?").run(NOW, sent)
  await inStep(store, db)

  db.prepare("DELETE FROM email_recipients WHERE email_id = ?").run(sent)
  db.prepare("UPDATE emails SET deleted_at = NULL WHERE id = ?").run(sent)
  await inStep(store, db)

  const meeting = Number(
    db
      .prepare(
        "INSERT INTO meetings (account_id, external_id, created_at, updated_at) VALUES (?, 'x', ?, ?) RETURNING id",
      )
      .get(tg, NOW, NOW)?.id,
  )
  db.prepare(
    "INSERT INTO meeting_participants (meeting_id, identity_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(meeting, pk("16"), NOW, NOW)
  await inStep(store, db)

  db.prepare("DELETE FROM meeting_participants WHERE identity_id = ?").run(pk("16"))
  await inStep(store, db)

  await store.people.saveAddressBook(TG, [{ id: "17", name: "Stranger 7" }])
  await inStep(store, db)
  await store.people.saveAddressBook(TG, [])
  await inStep(store, db)

  const organization = Number(
    db
      .prepare(
        "INSERT INTO organizations (kind, name, created_at, updated_at) VALUES ('company', 'Gym', ?, ?) RETURNING id",
      )
      .get(NOW, NOW)?.id,
  )
  db.prepare(
    "INSERT INTO organization_identities (identity_id, organization_id, method, author, created_at, updated_at) " +
      "VALUES (?, ?, 'manual', 'owner', ?, ?)",
  ).run(pk("18"), organization, NOW, NOW)
  await inStep(store, db)

  db.prepare("DELETE FROM organization_identities WHERE identity_id = ?").run(pk("18"))
  await inStep(store, db)

  const person19 = (await store.people.personOf({ provider: "telegram", id: "19" }))?.uid
  db.prepare(
    "INSERT INTO records (account_id, type, external_id, fields, fingerprint, batch_id, entity_type, entity_id, " +
      "created_at, updated_at, created_entity) VALUES (?, 'person', 'r1', '{}', 'f', 'b', 'person', ?, ?, ?, 0)",
  ).run(mail, person19 ?? null, NOW, NOW)
  await inStep(store, db)

  db.prepare("UPDATE records SET deleted_at = ? WHERE external_id = 'r1'").run(NOW)
  await inStep(store, db)

  db.prepare("UPDATE identities SET bot = 1 WHERE provider = 'telegram' AND external_id = '11'").run()
  await inStep(store, db)

  await store.knowledge.addProject({ name: "Harbour", key: "HRB", type: "work" })
  const task = await store.tasks.create({ project: "HRB", title: "Ship", type: "chore" }, "owner")
  const person20 = (await store.people.personOf({ provider: "telegram", id: "20" }))?.uid
  await store.tasks.assign(task.id, { to: `person:${person20}`, role: "assignee" }, "owner")
  await inStep(store, db)

  await store.people.linkIdentities(
    { provider: "telegram", id: "21" },
    { provider: "telegram", id: "20" },
    { method: "manual", by: "owner" },
  )
  await inStep(store, db)

  db.prepare("UPDATE tasks SET deleted_at = ? WHERE id IN (SELECT task_id FROM task_assignments)").run(NOW)
  await inStep(store, db)

  db.prepare("UPDATE tasks SET deleted_at = NULL").run()
  await inStep(store, db)

  db.prepare("DELETE FROM task_assignments").run()
  await inStep(store, db)

  await store.people.add({ name: "Nora" })
  await inStep(store, db)
})

it("pages in the stored order exactly as the whole list worked out in memory", async () => {
  const { store, db, path } = await opened()
  await store.people.savePeople(
    TG,
    Array.from({ length: 30 }, (_, n) => ({ id: String(100 + n), name: n % 3 === 0 ? "Twin" : `P ${n % 7}` })),
  )
  await store.chats.saveChats(TG, [chat("g", "group", 9)])
  await store.roster.saveMembers(
    TG,
    "g",
    Array.from({ length: 8 }, (_, n) => String(100 + n)),
  )
  const paged = async (sort: PeopleSort) => {
    const pages = []
    for (let offset = 0; offset < 40; offset += 4)
      pages.push(...(await store.people.list({ limit: 4, offset, kind: "all", sort })).items)
    return pages
  }
  const stored = await Promise.all(SORTS.map(paged))

  db.prepare("DELETE FROM store_settings WHERE key = 'people.kind_rules'").run()
  const readOnly = await openStore({ path, readOnly: true })
  handles.push(readOnly)
  const inMemory = await Promise.all(SORTS.map((sort) => readOnly.people.list({ limit: 100, kind: "all", sort })))

  expect(stored).toEqual(inMemory.map(({ items }) => items))
  expect(inMemory[0]?.total).toBe(31)
})

it("counts every kind at once, for the whole store or a name", async () => {
  const { store } = await opened()
  await store.people.savePeople(TG, [
    { id: "2", name: "Weather Notifications" },
    { id: "3", name: "Harbour Bank" },
    { id: "4", name: "Kai Stranger" },
    { id: "5", name: "!" },
  ])

  expect(await store.people.counts()).toEqual({ person: 1, organization: 1, automated: 1, stranger: 1, unsorted: 1 })
  expect(await store.people.counts("Harbour")).toEqual({
    person: 0,
    organization: 1,
    automated: 0,
    stranger: 0,
    unsorted: 0,
  })
  expect((await store.people.list({ limit: 1, kind: "stranger" })).counts).toEqual(await store.people.counts())
})

it("clears no stored kind when a sync writes again what the store holds, or a big group grows", async () => {
  const { store, db } = await opened()
  const sync = async () => {
    await store.people.savePeople(TG, [
      { id: "2", name: "Dina", username: "dina" },
      { id: "3", name: "Gala" },
    ])
    await store.chats.saveChats(TG, [chat("d", "dialog", 2), chat("g", "group", 5), chat("u", "group", null)])
    await store.roster.saveMembers(TG, "d", ["1", "2"])
    await store.roster.saveMembers(TG, "g", ["1", "2", "3"])
    await store.roster.saveMembers(TG, "u", ["1", "3"])
    await store.people.saveAddressBook(TG, [{ id: "3", name: "Gala" }])
  }
  await sync()
  await store.chats.saveChats(TG, [chat("big", "group", 5000), chat("channel", "channel", 900)])
  await store.roster.saveMembers(TG, "big", ["1", "2", "3"])
  await store.roster.saveMembers(TG, "channel", ["1", "2"])
  await store.people.list({ limit: 10 })

  await sync()
  await store.chats.saveChats(TG, [chat("big", "group", 5001), chat("channel", "channel", 899)])

  expect(db.prepare("SELECT count(*) AS n FROM persons WHERE kind IS NULL").get()?.n).toBe(0)
})

it("clears kinds on a group's size by the same line the ties draw", async () => {
  const { db } = await opened()
  const trigger = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'person_kind_chat_au'").get()?.sql)
  expect(trigger).toContain(`participants_count <= ${SMALL_GROUP_MEMBERS}`)
})
