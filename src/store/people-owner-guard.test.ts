import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { IDENTITY_LINK_KIND } from "./identity-links.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const OWN: AccountKey = { provider: "telegram", account: "1", scope: "personal" }
const PARTNER_MAIL: AccountKey = { provider: "email", account: "ya@partner.example", scope: "personal" }
const CRM: AccountKey = { provider: "bitrix24", account: "acme.example", scope: "work" }
const MAX: AccountKey = { provider: "max", account: "2", scope: "personal" }
const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

let path = ""
const open = async () => {
  path = join(mkdtempSync(join(tmpdir(), "owner-guard-")), "store.db")
  const store = await openStore({ path })
  handles.push(store)
  return store
}
const raw = async () => {
  const database = await openCache(path)
  handles.push(database)
  return database
}
const uidOf = async (store: MessageStore, provider: string, id: string) =>
  (await store.people.personOf({ provider, id }))?.uid as string
const ownerRefs = async (store: MessageStore) =>
  (await store.people.owner())?.identities.map(({ provider, id }) => `${provider}:${id}`).sort()
const openLinks = (store: MessageStore) =>
  store.proposedActions.list({ kinds: [IDENTITY_LINK_KIND], status: "proposed" })

const withOwner = async () => {
  const store = await open()
  await store.people.savePeople(OWN, [{ id: "1", name: "Aleksei Ivanov" }])
  await store.accounts.saveAccount(OWN, { name: null })
  return store
}

describe("an account the owner connects (SEC-177)", () => {
  it("under the owner's name in another script joins the owner", async () => {
    const store = await withOwner()
    await store.people.savePeople(MAX, [{ id: "2", name: "Иванов Алексей" }])
    await store.accounts.saveAccount(MAX, { name: null })

    expect(await ownerRefs(store)).toEqual(["max:2", "telegram:1"])
  })

  it("under another person's name is only proposed, with a warning, and the owner's confirm joins it", async () => {
    const store = await withOwner()
    await store.people.savePeople(MAX, [{ id: "2", name: "Svetlana 2" }])
    await store.accounts.saveAccount(MAX, { name: null })

    expect(await ownerRefs(store)).toEqual(["telegram:1"])
    const [proposal] = await openLinks(store)
    expect(proposal).toMatchObject({ payload: { signal: "account" } })
    expect(proposal?.reason).toMatch(/someone else's/)
    await store.people.decideLink(proposal?.id as string, { confirm: true, by: "owner" })
    expect(await ownerRefs(store)).toEqual(["max:2", "telegram:1"])
  })

  it("never joins the owner when it is a bot", async () => {
    const store = await withOwner()
    const bot: AccountKey = { provider: "telegram-bot", account: "8" }
    await store.people.savePeople(bot, [{ id: "8", name: "Aleksei Ivanov" }])
    await store.accounts.saveAccount(bot, { name: null })

    expect(await ownerRefs(store)).toEqual(["telegram:1"])
    expect(await openLinks(store)).toEqual([])
  })
})

describe("a partner's mailbox the owner reads (BUG-677)", () => {
  it("keeps the partner and his CRM records off the owner, and the CRM never renames the owner", async () => {
    const store = await withOwner()
    await store.people.savePeople(PARTNER_MAIL, [{ id: "ya@partner.example", name: "Пётр Соколов" }])
    await store.accounts.saveAccount(PARTNER_MAIL, { name: null })

    await store.people.savePeople(CRM, [
      { id: "contact/90", name: "Пётр Соколов", email: "ya@partner.example", phone: "+7 812 000-00-11" },
      { id: "user/33", name: "Соколов Пётр", email: "ya@partner.example" },
    ])
    await store.people.scanMatches()

    expect(await ownerRefs(store)).toEqual(["telegram:1"])
    const partner = await uidOf(store, "email", "ya@partner.example")
    expect(await uidOf(store, "bitrix24", "contact/90")).toBe(partner)
    expect(await uidOf(store, "bitrix24", "user/33")).toBe(partner)
    expect((await store.people.owner())?.name ?? "").not.toMatch(/Соколов/)
  })

  it("is not joined back once the owner takes it off, by the account rule or a CRM sync", async () => {
    const store = await withOwner()
    await store.people.savePeople(PARTNER_MAIL, [{ id: "ya@partner.example", name: null }])
    await store.accounts.saveAccount(PARTNER_MAIL, { name: null })
    expect(await ownerRefs(store)).toEqual(["email:ya@partner.example", "telegram:1"])

    await store.people.unlinkIdentity(
      { provider: "email", id: "ya@partner.example" },
      { method: "manual", by: "owner" },
    )
    await store.accounts.saveAccount(PARTNER_MAIL, { name: null })
    await store.people.savePeople(CRM, [{ id: "contact/90", name: "Пётр Соколов", email: "ya@partner.example" }])
    await store.people.scanMatches({ full: true })

    expect(await ownerRefs(store)).toEqual(["telegram:1"])
    expect(await uidOf(store, "bitrix24", "contact/90")).toBe(await uidOf(store, "email", "ya@partner.example"))
  })
})

describe("shared signals (SEC-177)", () => {
  it("a company's number an organization holds joins and proposes no one", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [{ id: "contact/1", name: "Ana", phone: "+7 812 000-00-11" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Bea", phone: "+78120000011" }])
    const database = await raw()
    const org = Number(
      database
        .prepare(
          "INSERT INTO organizations (kind, name, created_at, updated_at) VALUES ('company', 'Acme', 0, 0) RETURNING id",
        )
        .get()?.id,
    )
    database
      .prepare(
        "INSERT INTO organization_identities (organization_id, identity_id, method, author, created_at, updated_at) " +
          "SELECT ?, id, 'manual', 'owner', 0, 0 FROM identities WHERE provider = 'bitrix24'",
      )
      .run(org)

    const scan = await store.people.scanMatches()

    expect(scan.merged).toEqual([])
    expect(scan.proposed).toEqual([])
    expect(scan.skipped).toMatchObject([{ reason: "identity.shared-phone" }])
  })

  it("a bot's number or address joins and proposes no one", async () => {
    const store = await open()
    await store.people.savePeople(MAX, [{ id: "7", name: "Bea", phone: "+79001234567", email: "bea@x.example" }])
    await store.people.savePeople({ provider: "telegram-bot", account: "8" }, [
      { id: "8", name: "Shop bot", phone: "+79001234567", email: "bea@x.example" },
    ])

    const scan = await store.people.scanMatches()

    expect(scan.merged).toEqual([])
    expect(scan.proposed).toEqual([])
    expect(await uidOf(store, "telegram-bot", "8")).not.toBe(await uidOf(store, "max", "7"))
  })
})

describe("one name across sources (SEC-177, BUG-678)", () => {
  it("in two scripts with a phone only these two have is proposed, never joined", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [{ id: "contact/5", name: "Светлана Кузнецова", phone: "+7 900 000-00-01" }])
    await store.people.savePeople(CRM, [{ id: "contact/6", name: "Svetlana Kuznetsova", phone: "+7 900 000-00-01" }])

    const scan = await store.people.scanMatches()

    expect(scan.merged).toEqual([])
    expect(scan.proposed.length).toBeGreaterThan(0)
  })

  it("and only a company's mail domain in common is not proposed between sources", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [{ id: "contact/5", name: "Ana Lee", email: "ana@acme.example" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Ana Lee", email: "a.lee@acme.example" }])

    const scan = await store.people.scanMatches()

    expect(scan.proposed).toEqual([])
  })
})

describe("undoing the partner's merge into the owner (BUG-677)", () => {
  it("gives the owner back their own name", async () => {
    const store = await withOwner()
    await store.people.savePeople(CRM, [{ id: "contact/90", name: "Пётр Соколов null #90" }])
    const database = await raw()
    const owner = Number(database.prepare("SELECT id FROM persons WHERE owner = 1").get()?.id)
    const contact = Number(await uidOf(store, "bitrix24", "contact/90"))
    await store.people.linkToOwner({ provider: "bitrix24", id: "contact/90" })
    database.prepare("UPDATE persons SET name = 'Пётр Соколов null #90' WHERE id = ?").run(owner)

    await store.people.undoMerge(String(owner), String(contact), "owner")

    expect((await store.people.owner())?.name).toBe("Aleksei Ivanov")
    expect(await ownerRefs(store)).toEqual(["telegram:1"])
  })
})
