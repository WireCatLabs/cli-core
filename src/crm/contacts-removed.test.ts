import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { openCache } from "../store/open.js"
import { crmIdentityId } from "../store/sqlite/crm.js"
import { type MessageStore, openStore } from "../store/store.js"
import { syncCrm } from "./index.js"
import { exampleDeal, examplePerson, fakeCrmSource } from "./testing/index.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const PORTAL = { provider: "example-crm", account: "portal" }
const KEY = `crm.${PORTAL.provider}:${PORTAL.account}`

/** User 7 keeps d1 with Ann and Bea; user 9's d2 has Cy, Di and Ed. Di also writes by mail, Ed has a note. */
const portal = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "crm-contacts-")), "store.db")
  const store = await openStore({ path })
  stores.push(store)
  const source = fakeCrmSource({ self: "7" })
  source.put("person", examplePerson("1", { name: "Ann null #1" }))
  source.put("person", examplePerson("2", { name: "Bea" }))
  source.put("person", examplePerson("3", { name: "Cy null #3" }))
  source.put("person", examplePerson("4", { name: "Di null", email: "di@example.test" }))
  source.put("person", examplePerson("5", { name: "Ed" }))
  const on = (...ids: string[]) => ids.map((externalId) => ({ externalId, role: "contact" as const }))
  source.put("deal", exampleDeal("d1", { assignee: "7", people: on("1", "2") }))
  source.put("deal", exampleDeal("d2", { assignee: "9", people: on("3", "4", "5") }))
  await store.people.savePeople({ provider: "email", account: "di@example.test" }, [
    { id: "di@example.test", name: "Di", email: "di@example.test" },
  ])
  const sql = async <T>(body: (database: Awaited<ReturnType<typeof openCache>>) => T): Promise<T> => {
    const database = await openCache(path)
    try {
      return body(database)
    } finally {
      database.close()
    }
  }
  const set = (name: string, value: string) =>
    sql((database) =>
      database
        .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, 1)")
        .run(`${KEY}.${name}`, JSON.stringify(value)),
    )
  const personOf = (id: string) =>
    sql(
      (database) =>
        database
          .prepare(
            "SELECT p.id, p.name FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
              "JOIN persons p ON p.id = l.person_id WHERE i.provider = ? AND i.external_id = ?",
          )
          .get(...(id.includes("@") ? ["email", id] : [PORTAL.provider, crmIdentityId(PORTAL, id)])) as
          | { id: number; name: string | null }
          | undefined,
    )
  await set("scope", "all")
  await syncCrm(source, store, PORTAL)
  const ed = await personOf("5")
  await sql((database) =>
    database
      .prepare(
        "INSERT INTO notes (notable_type, notable_id, body, created_at, updated_at) VALUES ('person', ?, 'met', 1, 1)",
      )
      .run(Number(ed?.id)),
  )
  return { path, store, source, set, sql, personOf, ed }
}

it("a rescan under mine removes the contacts of deals left behind, keeps people with more, and cleans import names", async () => {
  const { store, source, set, sql, personOf, ed } = await portal()
  const cy = await personOf("3")
  await set("scope", "mine")
  const report = await syncCrm(source, store, PORTAL, { rescan: true })

  expect(report.contactsRemoved).toEqual({ contacts: 3, persons: 2, personsKept: 2, names: 1 })
  expect(await store.crm.count(PORTAL, "person")).toBe(2)
  expect(await personOf("3")).toBeUndefined()
  expect(await sql((database) => database.prepare("SELECT id FROM persons WHERE id = ?").get(Number(cy?.id)))).toBe(
    undefined,
  )
  expect(await personOf("di@example.test")).toMatchObject({ name: "Di" })
  expect(
    await sql((database) => database.prepare("SELECT name FROM persons WHERE id = ?").get(Number(ed?.id))),
  ).toEqual({ name: "Ed" })
  expect(await personOf("1")).toMatchObject({ name: "Ann" })
  expect(await personOf("2")).toMatchObject({ name: "Bea" })
  const dangling = await sql((database) =>
    database
      .prepare("SELECT count(*) AS n FROM links WHERE to_type = 'person' AND to_id NOT IN (SELECT id FROM persons)")
      .get(),
  )
  expect(dangling).toEqual({ n: 0 })
  expect((await syncCrm(source, store, PORTAL)).contactsRemoved).toBeUndefined()
})

it("a dry run counts and changes nothing; a contact the owner decided about stays; scope all removes none", async () => {
  const { store, source, set, sql } = await portal()
  expect((await syncCrm(source, store, PORTAL, { rescan: true })).contactsRemoved).toBeUndefined()
  await sql((database) =>
    database
      .prepare(
        "INSERT INTO identity_link_events (identity_id, from_person_id, to_person_id, method, created_at, author) " +
          "SELECT i.id, NULL, l.person_id, 'link', 1, 'owner' FROM identities i " +
          "JOIN identity_links l ON l.identity_id = i.id WHERE i.external_id = ?",
      )
      .run(crmIdentityId(PORTAL, "3")),
  )
  await set("scope", "mine")
  const before = Date.now() + 60_000
  const counted = await store.crm.removeContacts(PORTAL, { users: ["7"], before, dryRun: true })
  expect(counted).toEqual({ contacts: 2, persons: 1, personsKept: 2, names: 2 })
  expect(await store.crm.count(PORTAL, "person")).toBe(5)
  expect(await store.crm.removeContacts(PORTAL, { users: ["7"], before })).toEqual(counted)
  expect(await store.crm.count(PORTAL, "person")).toBe(3)
})

it("forgets a proposed split that names a removed contact, since it holds the contact's address", async () => {
  const { store, source, set } = await portal()
  const di = { provider: PORTAL.provider, id: crmIdentityId(PORTAL, "4") }
  await store.people.proposeSplit({ identities: [di], by: { bot: "claude-code" }, reason: "another Di" })
  await set("scope", "mine")
  await syncCrm(source, store, PORTAL, { rescan: true })

  expect((await store.people.splitProposals({ status: "all", limit: 10, offset: 0 })).items).toEqual([])
})
