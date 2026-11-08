import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const PORTAL = { provider: "example-crm", account: "portal-a" }
const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const one of opened.splice(0)) await one.close()
})

const open = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "merged-persons-")), "store.db")
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

const count = (raw: CacheDatabase, where: string) =>
  Number(raw.prepare(`SELECT count(*) AS n FROM persons WHERE ${where}`).get()?.n)

const ghosts = (raw: CacheDatabase) =>
  raw
    .prepare("SELECT id, merged_into AS target FROM persons WHERE merged_into IS NOT NULL ORDER BY id")
    .all()
    .map((row) => ({ id: Number(row.id), into: Number(row.target) }))

describe("contacts joined by e-mail", () => {
  it("leave one live person per contact, the emptied ones merged into it and its history kept", async () => {
    const { store, raw } = await open()
    await store.crm.savePeople(PORTAL, contacts(5))
    await store.crm.savePeople(PORTAL, contacts(5))

    expect(count(raw, "owner = 0 AND merged_into IS NULL")).toBe(5)
    const merged = ghosts(raw)
    expect(merged).toHaveLength(5)
    for (const { id, into } of merged) {
      expect(raw.prepare("SELECT 1 FROM identity_links WHERE person_id = ?").get(id)).toBeUndefined()
      expect(raw.prepare("SELECT 1 FROM identity_links WHERE person_id = ?").get(into)).toBeDefined()
      expect(
        raw
          .prepare("SELECT method FROM identity_link_events WHERE from_person_id = ? AND to_person_id = ?")
          .get(id, into),
      ).toMatchObject({ method: "same-email" })
    }

    const listed = (await store.tasks.taskPeople()).map(({ person }) => person)
    for (const { id } of merged) expect(listed).not.toContain(`person:${id}`)
  })

  it("reads an old person id as the person it was merged into", async () => {
    const { store, raw } = await open()
    await store.crm.savePeople(PORTAL, contacts(1))
    const [ghost] = ghosts(raw)
    if (!ghost) throw new Error("no merged person")
    const record = await store.people.personByUid(String(ghost.id))
    expect(record?.uid).toBe(String(ghost.into))
    expect(record?.identities.map(({ provider }) => provider).sort()).toEqual(["email", "example-crm"])

    const account = Number(raw.prepare("SELECT id FROM accounts WHERE provider = 'example-crm'").get()?.id)
    expect(await store.people.personSeenInAccounts(String(ghost.id), [account])).toBe(true)
  })
})

describe("the merge mark", () => {
  const twoPeople = async (store: MessageStore, one: string, other: string) => {
    await store.people.savePeople({ provider: "example-chat", account: "me" }, [
      { id: one, name: one },
      { id: other, name: other },
    ])
  }
  const uidOf = async (store: MessageStore, id: string) =>
    (await store.people.personOf({ provider: "example-chat", id }))?.uid

  it("follows a merge of a merge to the person that holds the identities", async () => {
    const { store, raw } = await open()
    await twoPeople(store, "a", "b")
    await twoPeople(store, "c", "b")
    const [a, c] = [await uidOf(store, "a"), await uidOf(store, "c")]
    await store.people.linkIdentities(
      { provider: "example-chat", id: "b" },
      { provider: "example-chat", id: "a" },
      MANUAL,
    )
    await store.people.linkIdentities(
      { provider: "example-chat", id: "c" },
      { provider: "example-chat", id: "b" },
      MANUAL,
    )
    const live = await uidOf(store, "c")
    expect(live).toBe(c)
    expect(ghosts(raw).find(({ id }) => String(id) === a)?.into).toBe(Number(live))
    expect((await store.people.personByUid(String(a)))?.uid).toBe(live)
  })

  it("is set by a plain identity_links update, as an older build writes it", async () => {
    const { store, raw } = await open()
    await twoPeople(store, "a", "b")
    const [a, b] = [await uidOf(store, "a"), await uidOf(store, "b")]
    raw.prepare("UPDATE identity_links SET person_id = ? WHERE person_id = ?").run(Number(b), Number(a))
    expect(ghosts(raw)).toEqual([{ id: Number(a), into: Number(b) }])
  })

  it("leaves a person known by name only and the owner alone", async () => {
    const { store, raw } = await open()
    const named = await store.people.add({ name: "Name Only" })
    await store.crm.savePeople(PORTAL, contacts(2))
    const marked = ghosts(raw).map(({ id }) => String(id))
    expect(marked).not.toContain(named.uid)
    expect(count(raw, "owner = 1 AND merged_into IS NOT NULL")).toBe(0)
    expect((await store.tasks.taskPeople()).map(({ person }) => person)).toContain(`person:${named.uid}`)
  })
})

const MANUAL = { method: "manual", by: "owner" } as const
