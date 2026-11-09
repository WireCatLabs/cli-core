import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const PORTAL = { provider: "example-crm", account: "portal-a" }
const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const one of opened.splice(0)) await one.close()
})

const open = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "crm-email-join-")), "store.db")
  const store = await openStore({ path })
  const raw = await openCache(path)
  opened.push(store, raw)
  return { store, raw }
}

const contacts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    externalId: String(i + 1),
    name: `Contact ${i + 1}`,
    email: `c${i + 1}@example.com`,
  }))

const listed = async (store: MessageStore) =>
  (await store.tasks.taskPeople()).filter(({ owner }) => !owner).map(({ person }) => person)

const emptied = (raw: CacheDatabase) =>
  raw
    .prepare(
      "SELECT DISTINCT e.from_person_id AS id, e.to_person_id AS target FROM identity_link_events e " +
        "WHERE e.method = 'same-email' AND NOT EXISTS (SELECT 1 FROM identity_links l WHERE l.person_id = e.from_person_id)",
    )
    .all()
    .map((row) => ({ id: String(row.id), target: String(row.target) }))

it("lists one person per CRM contact joined by e-mail, and reads an emptied person as the one it joined", async () => {
  const { store, raw } = await open()
  await store.crm.savePeople(PORTAL, contacts(5))
  await store.crm.savePeople(PORTAL, contacts(5))

  const people = await listed(store)
  expect(people).toHaveLength(5)
  const ghosts = emptied(raw)
  expect(ghosts).toHaveLength(5)
  const account = Number(raw.prepare("SELECT id FROM accounts WHERE provider = 'example-crm'").get()?.id)
  for (const { id, target } of ghosts) {
    expect(people).not.toContain(`person:${id}`)
    expect(await store.people.personByUid(id)).toMatchObject({ uid: target, mergedInto: target })
    expect(await store.people.personSeenInAccounts(id, [account])).toBe(true)
  }
})

it("hides a person an older build emptied by an e-mail join, from the rows it left", async () => {
  const { store, raw } = await open()
  await store.people.savePeople({ provider: "example-chat", account: "me" }, [{ id: "a", name: "Ana" }])
  const ana = String((await store.people.personOf({ provider: "example-chat", id: "a" }))?.uid)
  const mail = await store.people.add({ name: "ana@example.com" })
  raw.prepare("UPDATE identity_links SET person_id = ? WHERE person_id = ?").run(Number(mail.uid), Number(ana))
  raw
    .prepare(
      "INSERT INTO identity_link_events (identity_id, from_person_id, to_person_id, method, created_at, author) " +
        "SELECT identity_id, ?, ?, 'same-email', 1, 'example-crm' FROM identity_links WHERE person_id = ?",
    )
    .run(Number(ana), Number(mail.uid), Number(mail.uid))

  expect(await listed(store)).toEqual([`person:${mail.uid}`])
  expect((await store.people.personByUid(ana))?.uid).toBe(mail.uid)
})
