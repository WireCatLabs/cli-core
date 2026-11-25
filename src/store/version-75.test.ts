import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import { LIST_SENDERS } from "./sqlite/sender-signals.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const TG: AccountKey = { provider: "telegram", account: "1" }
const MAIL: AccountKey = { provider: "email", account: "me@acme.ru" }

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const opened = async (path = join(mkdtempSync(join(tmpdir(), "version-75-")), "store.db")) => {
  const store = await openStore({ path })
  handles.push(store)
  await store.people.savePeople(TG, [{ id: "1", name: "Me" }])
  await store.people.linkToOwner({ provider: "telegram", id: "1" })
  await store.accounts.saveAccount(MAIL, { name: null })
  const db = await openCache(path)
  handles.push(db)
  return { store, db, path }
}

const bots = async (store: MessageStore) =>
  (await store.people.listBots({ limit: 100 })).items.map(({ displayName, identities, author }) => ({
    displayName,
    identities: identities.map(({ provider, id }) => `${provider}:${id}`),
    author,
  }))

const count = (db: CacheDatabase, sql: string) => Number(db.prepare(sql).get()?.n)

it("moves a version 74 store's bots off their people, and an older build's writes keep them apart", async () => {
  const { store, db, path } = await opened()
  await store.people.savePeople(MAIL, [
    { id: "noreply@service.ru", name: "Service" },
    { id: "pat@later.ru", name: "Pat Later" },
  ])
  await store.close()
  handles.splice(handles.indexOf(store), 1)
  db.close()
  handles.splice(handles.indexOf(db), 1)
  const old = await openCache(path)
  rollBackTo(old, 75)
  const service = Number(
    old
      .prepare(
        "SELECT person_id FROM identity_links l JOIN identities i ON i.id = l.identity_id WHERE i.external_id = ?",
      )
      .get("noreply@service.ru")?.person_id,
  )
  old
    .prepare(
      "INSERT INTO sender_bots (person_id, name, author, reason, created_at, updated_at) " +
        "VALUES (?, 'Service bot', 'owner', 'a program', 1, 1)",
    )
    .run(service)
  old.close()

  const upgraded = await openStore({ path })
  handles.push(upgraded)
  const after = await openCache(path)
  handles.push(after)

  expect(await bots(upgraded)).toEqual(
    expect.arrayContaining([{ displayName: "Service bot", identities: ["email:noreply@service.ru"], author: "owner" }]),
  )
  expect(after.prepare("SELECT kind FROM persons WHERE id = ?").get(service)).toEqual({ kind: "merged" })
  // A 1.0 build that works the kind out again stores the person's kind: it stays hidden.
  after.prepare("UPDATE persons SET kind = 'automated' WHERE id = ?").run(service)
  expect(after.prepare("SELECT kind FROM persons WHERE id = ?").get(service)).toEqual({ kind: "merged" })
  expect(count(after, "SELECT count(*) AS n FROM sender_bots WHERE person_id > 0")).toBe(0)
  const identity = Number(after.prepare("SELECT id FROM identities WHERE external_id = 'noreply@service.ru'").get()?.id)

  // A 1.0 build's sync: a person for the identity with no link, its link and the log row, as `ensurePerson` writes.
  const persons = count(after, "SELECT count(*) AS n FROM persons")
  const made = Number(
    after.prepare("INSERT INTO persons (name, created_at, updated_at) VALUES ('Service', 2, 2) RETURNING id").get()?.id,
  )
  after
    .prepare(
      "INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, updated_at) " +
        "VALUES (?, ?, 'initial', 1, 2, 'ingest', 2)",
    )
    .run(identity, made)
  after
    .prepare(
      "INSERT INTO identity_link_events (identity_id, from_person_id, to_person_id, method, created_at, author) " +
        "VALUES (?, NULL, ?, 'initial', 2, 'ingest')",
    )
    .run(identity, made)
  expect(count(after, "SELECT count(*) AS n FROM persons")).toBe(persons)
  expect(after.prepare("SELECT 1 FROM identity_links WHERE identity_id = ?").get(identity)).toBeUndefined()

  // A 1.0 build gives a rule's bot back by deleting its row, and sorts a new one onto a person row.
  const held = Number(
    after.prepare("SELECT bot_id FROM sender_bot_identities WHERE identity_id = ?").get(identity)?.bot_id,
  )
  after.prepare("DELETE FROM sender_bots WHERE id = ?").run(held)
  expect(after.prepare("SELECT 1 FROM sender_bots WHERE id = ?").get(held)).toBeDefined()
  const later = Number(
    after
      .prepare(
        "SELECT person_id FROM identity_links l JOIN identities i ON i.id = l.identity_id WHERE i.external_id = ?",
      )
      .get("pat@later.ru")?.person_id,
  )
  after
    .prepare(
      "INSERT INTO sender_bots (person_id, author, reason, created_at, updated_at) VALUES (?, 'rules', 'no-reply', 3, 3)",
    )
    .run(later)

  expect((await bots(upgraded)).map(({ identities }) => identities)).toEqual(
    expect.arrayContaining([["email:pat@later.ru"]]),
  )
  expect(count(after, "SELECT count(*) AS n FROM sender_bots WHERE person_id > 0")).toBe(0)
  const plan = after
    .prepare(`EXPLAIN QUERY PLAN ${LIST_SENDERS}`)
    .all('["<news.example>"]')
    .map((row) => String(row.detail))
  expect(plan.join(" ")).toContain("emails_by_list_id")
})
