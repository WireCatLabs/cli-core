import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { domainListsDirectory, type InstalledPack, listFile } from "../domain/domain-lists.js"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const TG: AccountKey = { provider: "telegram", account: "1" }
const MAIL: AccountKey = { provider: "email", account: "me@acme.ru" }

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const opened = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "domain-organizations-")), "store.db")
  const store = await openStore({ path })
  handles.push(store)
  await store.people.savePeople(TG, [{ id: "1", name: "Me" }])
  await store.people.linkToOwner({ provider: "telegram", id: "1" })
  await store.accounts.saveAccount(MAIL, { name: null })
  const db = await openCache(path)
  handles.push(db)
  return { store, db }
}

const sorted = (store: MessageStore) => store.people.list({ limit: 100, kind: "all" })

/** Makes the next list work out every kind, and so the domain rule, again. */
const resort = async (store: MessageStore, db: CacheDatabase) => {
  db.prepare("UPDATE persons SET kind = NULL").run()
  await sorted(store)
}

const holdings = (db: CacheDatabase) =>
  db
    .prepare(
      "SELECT o.name, i.external_id AS address, oi.method, oi.author FROM organizations o " +
        "JOIN organization_identities oi ON oi.organization_id = o.id JOIN identities i ON i.id = oi.identity_id " +
        "ORDER BY i.external_id",
    )
    .all()

const memberships = (db: CacheDatabase) =>
  db
    .prepare(
      "SELECT l.from_id AS person, o.name, l.author, l.confirmed FROM links l JOIN organizations o ON o.id = l.to_id " +
        "WHERE l.kind = 'member-of' AND l.from_type = 'person' AND l.to_type = 'organization' ORDER BY l.from_id",
    )
    .all()

const uidOf = async (store: MessageStore, provider: string, id: string) =>
  Number((await store.people.personOf({ provider, id }))?.uid)

it("puts a bot and a shared mailbox of one company domain, subdomains too, into one organization", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [
    { id: "noreply@mail.bank.ru", name: "Bank" },
    { id: "info@bank.ru", name: "Bank Support" },
  ])

  await sorted(store)

  expect(holdings(db)).toEqual([
    { name: "Bank", address: "info@bank.ru", method: "domain", author: "rules" },
    { name: "Bank", address: "noreply@mail.bank.ru", method: "domain", author: "rules" },
  ])
  const organization = db.prepare("SELECT id FROM organizations").get()?.id
  expect(db.prepare("SELECT organization_id FROM sender_bots").all()).toEqual([{ organization_id: organization }])
  expect((await store.people.linkProposals({ limit: 10, offset: 0 })).items).toEqual([])
})

it("names the organization by its domain when the sender's name is no company's", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [{ id: "alerts-noreply@shop.ru", name: "Your order" }])

  await sorted(store)

  expect(holdings(db).map(({ name }) => name)).toEqual(["shop.ru"])
})

it("makes no organization for free mail or throwaway mail", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [
    { id: "noreply@gmail.com", name: "Gmail Robot" },
    { id: "info@mailinator.com", name: "Mailinator" },
  ])

  await sorted(store)

  expect(db.prepare("SELECT count(*) AS n FROM organizations").get()?.n).toBe(0)
})

it("never groups two newsletters by the platform that sends them", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [
    { id: "alpha-noreply@substack.com", name: "Alpha Weekly" },
    { id: "beta-noreply@substack.com", name: "Beta Digest" },
    { id: "news@ghost.io", name: "Gamma" },
  ])

  await sorted(store)

  expect(db.prepare("SELECT count(*) AS n FROM organizations").get()?.n).toBe(0)
  expect(memberships(db)).toEqual([])
})

it("links a human at the company domain as a member, never merged, whichever came first", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [{ id: "lena@studio.ru", name: "Lena Marsh" }])
  await sorted(store)
  expect(memberships(db)).toEqual([])

  await store.people.savePeople(MAIL, [{ id: "noreply@studio.ru", name: "Studio" }])
  await sorted(store)
  await store.people.savePeople(MAIL, [{ id: "oleg@studio.ru", name: "Oleg Kim" }])
  await sorted(store)

  const lena = await uidOf(store, "email", "lena@studio.ru")
  const oleg = await uidOf(store, "email", "oleg@studio.ru")
  expect(memberships(db)).toEqual([
    { person: lena, name: "Studio", author: "rule", confirmed: 1 },
    { person: oleg, name: "Studio", author: "rule", confirmed: 1 },
  ])
  expect(holdings(db).map(({ address }) => address)).toEqual(["noreply@studio.ru"])
  const listed = (await sorted(store)).items.find(({ person }) => person === `person:${lena}`)
  expect(listed?.kind).not.toBe("organization")
  expect((await store.people.linkProposals({ limit: 10, offset: 0 })).items).toEqual([])
})

it("keeps the owner's separations: a removed membership, an erased organization, a bot made a person", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [
    { id: "noreply@studio.ru", name: "Studio" },
    { id: "lena@studio.ru", name: "Lena Marsh" },
    { id: "noreply@bank.ru", name: "Bank" },
    { id: "noreply@shop.ru", name: "Shop" },
  ])
  await sorted(store)
  const lena = await uidOf(store, "email", "lena@studio.ru")
  const [relation] = (await store.knowledge.relations(null, `person:${lena}`)).filter((one) => one.kind === "member-of")
  expect(relation).toMatchObject({ derived: "mail-domain" })

  await store.knowledge.removeRelation(null, String(relation?.id), "owner")
  const bank = Number(db.prepare("SELECT id FROM organizations WHERE name = 'Bank'").get()?.id)
  await store.knowledge.eraseOrganization(`organization:${bank}`, "owner", { apply: true })
  await store.people.moveToPerson({ provider: "email", id: "noreply@shop.ru" }, "owner")
  await resort(store, db)

  expect(memberships(db)).toEqual([])
  expect(holdings(db).map(({ name, address }) => `${name} ${address}`)).toEqual(["Studio noreply@studio.ru"])
})

it("changes nothing when it runs again", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [
    { id: "noreply@studio.ru", name: "Studio" },
    { id: "info@studio.ru", name: "Studio Team" },
    { id: "lena@studio.ru", name: "Lena Marsh" },
  ])
  await sorted(store)
  const rows = () => ({
    organizations: db.prepare("SELECT * FROM organizations").all(),
    holdings: db.prepare("SELECT * FROM organization_identities").all(),
    links: db.prepare("SELECT * FROM links").all(),
    bots: db.prepare("SELECT * FROM sender_bots").all(),
  })
  const before = rows()

  await resort(store, db)

  expect(rows()).toEqual(before)
  expect(db.prepare("SELECT count(*) AS n FROM persons WHERE kind IS NULL").get()?.n).toBe(0)
})

it("gives an organization the sector of its domain from the Wikidata list, and none for free mail", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [
    { id: "noreply@mail.hsbc.com", name: "HSBC" },
    { id: "info@studio.ru", name: "Studio" },
    { id: "boss@mail.ru", name: "Boss" },
  ])
  await sorted(store)
  const club = await store.knowledge.addOrganization({ kind: "company", name: "Club" })
  const freeMail = db.prepare("SELECT id FROM identities WHERE external_id = 'boss@mail.ru'").get()?.id
  db.prepare(
    "INSERT INTO organization_identities (identity_id, organization_id, method, author, created_at, updated_at) " +
      "VALUES (?, ?, 'owner', 'owner', 0, 0)",
  ).run(Number(freeMail), Number(club.id))

  await resort(store, db)

  const sectors = (await store.knowledge.organizations()).map(({ name, sector }) => ({ name, sector }))
  expect(sectors).toEqual([
    { name: "Club", sector: null },
    { name: "HSBC", sector: "bank" },
    { name: "Studio", sector: null },
  ])
  const before = db.prepare("SELECT * FROM organizations").all()
  await resort(store, db)
  expect(db.prepare("SELECT * FROM organizations").all()).toEqual(before)
})

/** A pack in place as `domain-lists update` leaves it: one sector list, one bad list. */
const installPack = (version: string, sectors: string[]) => {
  const directory = domainListsDirectory()
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  const source = {
    title: "test",
    licence: "CC0",
    licence_url: "https://example.org",
    class: "commercial-ok" as const,
    attribution: "test",
    homepage: "https://example.org",
    url: "https://example.org/list.gz",
  }
  const pack: InstalledPack = {
    version,
    built_at: "2026-11-25T00:00:00.000Z",
    installed_at: "2026-11-25T00:00:00.000Z",
    commercial_only: false,
    sources: [
      { ...source, id: "sectors", signal: "sector" },
      { ...source, id: "bad", signal: "bad", tag: "malware" },
    ],
    files: {
      sectors: { sha256: "", lines: sectors.length, bytes: 0 },
      bad: { sha256: "", lines: 1, bytes: 0 },
    },
  }
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(pack))
  writeFileSync(listFile(directory, "sectors"), `${sectors.join("\n")}\n`)
  writeFileSync(listFile(directory, "bad"), "casino.ru\n")
}

it("takes sectors from the domain-list pack where the built-in table has none, and clears them when a newer pack drops them", async () => {
  try {
    installPack("2026-11-24", ["casino.ru\tgaming_gambling", "hsbc.com\tadult", "shop.ru\tshop"])
    const { store, db } = await opened()
    await store.people.savePeople(MAIL, [
      { id: "noreply@casino.ru", name: "Casino" },
      { id: "noreply@hsbc.com", name: "HSBC" },
      { id: "noreply@shop.ru", name: "Shop" },
    ])
    await sorted(store)
    const sectors = async () => (await store.knowledge.organizations()).map(({ name, sector }) => ({ name, sector }))
    expect(await sectors()).toEqual([
      { name: "Casino", sector: "gaming_gambling" },
      { name: "HSBC", sector: "bank" },
      { name: "Shop", sector: "shop" },
    ])
    db.prepare(
      "UPDATE organizations SET metadata = json_set(metadata, '$.sector', 'news', '$.sector_by', 'owner') WHERE name = 'Shop'",
    ).run()

    installPack("2026-11-25", [])
    await resort(store, db)

    expect(await sectors()).toEqual([
      { name: "Casino", sector: null },
      { name: "HSBC", sector: "bank" },
      { name: "Shop", sector: "news" },
    ])
    const before = db.prepare("SELECT * FROM organizations").all()
    await resort(store, db)
    expect(db.prepare("SELECT * FROM organizations").all()).toEqual(before)
  } finally {
    rmSync(domainListsDirectory(), { recursive: true, force: true })
  }
})

it("makes no organization for a free-mail provider of the built-in list", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [{ id: "noreply@seznam.cz", name: "Seznam" }])
  await sorted(store)
  expect(holdings(db)).toEqual([])
})
