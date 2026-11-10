import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { sampleMeeting } from "../meetings/testing/index.js"
import { IDENTITY_LINK_KIND } from "./identity-links.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const WORK: AccountKey = { provider: "bitrix24", account: "acme.example", scope: "work" }
const PERSONAL: AccountKey = { provider: "telegram", account: "1", scope: "personal" }
const MAX: AccountKey = { provider: "max", account: "2" }
const owner = { method: "manual", by: "owner" }
const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

let path = ""
const open = async () => {
  path = join(mkdtempSync(join(tmpdir(), "person-match-scan-")), "store.db")
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

const linkProposals = (store: MessageStore) => store.proposedActions.list({ kinds: [IDENTITY_LINK_KIND] })

describe("the same address", () => {
  it("is one person across a work and a personal account", async () => {
    const store = await open()
    await store.accounts.saveAccount(WORK, { name: null })
    await store.accounts.saveAccount(PERSONAL, { name: null })
    await store.people.savePeople(WORK, [{ id: "contact/20", name: "Alice Example", email: "alice@acme.example" }])
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Alice", email: "Alice@Acme.example" }])

    expect(await uidOf(store, "telegram", "5")).toBe(await uidOf(store, "bitrix24", "contact/20"))
    expect(await linkProposals(store)).toEqual([])
  })

  it("joins people an older write left apart, and the scan records it as a rule's merge", async () => {
    const store = await open()
    await store.people.savePeople(WORK, [{ id: "contact/20", name: "Alice Example", email: "alice@acme.example" }])
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Alice" }])
    ;(await raw()).prepare("UPDATE identities SET email = 'alice@acme.example' WHERE provider = 'telegram'").run()

    const scan = await store.people.scanMatches()

    const alice = await uidOf(store, "bitrix24", "contact/20")
    expect(await uidOf(store, "telegram", "5")).toBe(alice)
    expect(scan.merged).toMatchObject([{ into: alice, signal: "same-email" }])
    expect((await store.people.merges(alice))[0]).toMatchObject({ method: "same-email", by: "rule" })
  })

  it("does not join people again once the owner undid their merge", async () => {
    const store = await open()
    await store.people.savePeople(WORK, [{ id: "contact/20", name: "Alice Example" }])
    const crm = await uidOf(store, "bitrix24", "contact/20")
    await store.people.savePeople(WORK, [{ id: "contact/20", name: "Alice Example", email: "alice@acme.example" }])
    await store.people.undoMerge(await uidOf(store, "email", "alice@acme.example"), crm, "owner")

    const scan = await store.people.scanMatches()

    expect(await uidOf(store, "bitrix24", "contact/20")).toBe(crm)
    expect(await uidOf(store, "email", "alice@acme.example")).not.toBe(crm)
    expect(scan.merged).toEqual([])
    expect(scan.skipped).toMatchObject([{ signal: "same-email", reason: "identity.separated" }])
  })
})

describe("a shared mailbox (NEED-2526)", () => {
  const sharedProposals = async (store: MessageStore) =>
    (await store.people.linkProposals({ limit: 50, offset: 0 })).items.filter(({ signal }) => signal === "email")

  it("with nothing else in common is proposed with a low score and never joined", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana Diaz", email: "info@shop.example" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Bo Lind", email: "info@shop.example" }])

    const scan = await store.people.scanMatches({ full: true })

    expect(scan.merged).toEqual([])
    expect(await uidOf(store, "telegram", "5")).not.toBe(await uidOf(store, "max", "7"))
    expect(await sharedProposals(store)).toMatchObject([
      { joins: "person", shared: "role", score: 0.1, reason: "both have the shared mailbox info@shop.example" },
    ])
  })

  it("scores higher when the two people have one name, and higher again with a chat they are both in", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [
      { id: "5", name: "Ana Diaz", email: "info@shop.example" },
      { id: "6", name: "Diaz Ana", email: "info@shop.example" },
      { id: "8", name: "Bo Lind", email: "hello@cafe.example" },
      { id: "9", name: "Bo Lind", email: "hello@cafe.example" },
    ])
    await store.chats.saveChats(PERSONAL, [
      { id: "g", title: "g", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 40 },
    ])
    await store.roster.saveMembers(PERSONAL, "g", ["8", "9"])

    await store.people.scanMatches({ full: true })

    const found = await sharedProposals(store)
    expect(found.map(({ identity, score }) => [identity, score]).sort()).toEqual([
      ["telegram:5", 0.5],
      ["telegram:8", 0.7],
    ])
    expect(found.find(({ score }) => score === 0.7)?.reason).toBe(
      "both have the shared mailbox hello@cafe.example; the same name «Bo Lind»; a chat they are both in",
    )
    expect(found.find(({ score }) => score === 0.7)?.evidence).toHaveLength(1)
  })

  it("never keeps a messenger's phone from joining the two people who have it", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [
      { id: "6", name: "Bo Lind", email: "hello@cafe.example", phone: "+34 600 000 001" },
    ])
    await store.people.savePeople(MAX, [
      { id: "8", name: "Bo Lind", email: "hello@cafe.example", phone: "+34600000001" },
    ])

    const scan = await store.people.scanMatches({ full: true })

    expect(scan.merged).toMatchObject([{ signal: "same-phone" }])
    expect(await uidOf(store, "telegram", "6")).toBe(await uidOf(store, "max", "8"))
    expect(await sharedProposals(store)).toEqual([])
  })

  it("is proposed on the first pass after an older one, which never proposed it", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana Diaz", email: "info@shop.example" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Bo Lind", email: "info@shop.example" }])
    const now = await store.people.scanMatches()
    const database = await raw()
    const [proposal] = await sharedProposals(store)
    database.prepare("DELETE FROM proposed_actions WHERE id = ?").run(Number(proposal?.id))
    const cursor = JSON.parse(
      String(database.prepare("SELECT value FROM store_settings WHERE key = 'people.scan'").get()?.value),
    )
    delete cursor.rules
    database.prepare("UPDATE store_settings SET value = ? WHERE key = 'people.scan'").run(JSON.stringify(cursor))

    const next = await store.people.scanMatches()

    expect([now.full, next.full]).toEqual([true, true])
    expect(await sharedProposals(store)).toHaveLength(1)
    expect((await store.people.scanMatches()).full).toBe(false)
  })

  it("from the no-reply family proposes no one", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana Diaz", email: "noreply@shop.example" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Ana Diaz", email: "noreply@shop.example" }])

    const scan = await store.people.scanMatches({ full: true })

    expect(scan.merged).toEqual([])
    expect(await sharedProposals(store)).toEqual([])
  })

  it("two contacts of one CRM list have is a company's line, proposed and never joined", async () => {
    const store = await open()
    await store.people.savePeople(WORK, [
      { id: "contact/1", name: "Ana Diaz", email: "ana.desk@shop.example" },
      { id: "contact/2", name: "Bo Lind", email: "ana.desk@shop.example" },
    ])

    const scan = await store.people.scanMatches({ full: true })

    expect(scan.merged).toEqual([])
    const lines = await sharedProposals(store)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every(({ shared, score }) => shared === "line" && score === 0.1)).toBe(true)
  })
})

describe("a phone", () => {
  it("joins the two people who have it, whether kept with or without the +", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana", phone: "79001234567" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Anya", phone: "+79001234567" }])

    const scan = await store.people.scanMatches()

    expect(await uidOf(store, "telegram", "5")).toBe(await uidOf(store, "max", "7"))
    expect(scan.merged).toMatchObject([{ signal: "same-phone" }])
  })

  it("reads a CRM's formatted international number, and never guesses the country of a national one", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana", phone: "79001234567" }])
    await store.people.savePeople(WORK, [{ id: "contact/20", name: "Ana Example", phone: "+7 (900) 123-45-67" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Anya", phone: "8 900 123-45-67" }])

    const scan = await store.people.scanMatches()

    expect(await uidOf(store, "bitrix24", "contact/20")).toBe(await uidOf(store, "telegram", "5"))
    expect(await uidOf(store, "max", "7")).not.toBe(await uidOf(store, "telegram", "5"))
    expect(scan.merged).toHaveLength(1)
  })

  it("neither joins nor proposes a contact with the owner's number, and the owner's own link keeps the owner", async () => {
    const store = await open()
    await store.people.savePeople(WORK, [{ id: "contact/20", name: "Slava Example", phone: "+7 900 123-45-67" }])
    await store.people.savePeople(PERSONAL, [{ id: "9", name: "Slava", phone: "79001234567" }])
    const me = { uid: await uidOf(store, "telegram", "9") }
    const database = await raw()
    database.prepare("UPDATE persons SET owner = 0").run()
    database.prepare("UPDATE persons SET owner = 1 WHERE id = ?").run(Number(me.uid))
    expect(Number(me.uid)).toBeGreaterThan(Number(await uidOf(store, "bitrix24", "contact/20")))

    const scan = await store.people.scanMatches()

    expect(scan.merged).toEqual([])
    expect(scan.proposed).toEqual([])
    expect(scan.skipped).toMatchObject([{ reason: "identity.owner" }])
    expect((await store.people.owner())?.identities.map(({ provider }) => provider)).toEqual(["telegram"])
    await store.people.linkIdentities(
      { provider: "telegram", id: "9" },
      { provider: "bitrix24", id: "contact/20" },
      { method: "manual", by: "owner" },
    )
    const owner = await store.people.owner()
    expect(owner?.uid).toBe(me.uid)
    expect(owner?.identities.map(({ provider }) => provider).sort()).toEqual(["bitrix24", "telegram"])
  })

  it("never joins two people the owner separated", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana", phone: "79001234567" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Anya", phone: "79001234567" }])
    await store.people.linkIdentities({ provider: "telegram", id: "5" }, { provider: "max", id: "7" }, owner)
    await store.people.unlinkIdentity({ provider: "max", id: "7" }, owner)

    const scan = await store.people.scanMatches()

    expect(await uidOf(store, "telegram", "5")).not.toBe(await uidOf(store, "max", "7"))
    expect(scan.skipped).toMatchObject([{ signal: "same-phone", reason: "identity.separated" }])
  })

  it("that three people share proposes each pair once, a later pass looks only at what changed, and a rejected pair stays rejected", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [
      { id: "5", name: "Ana", phone: "79001234567" },
      { id: "6", name: "Bea", phone: "79001234567" },
    ])
    await store.people.savePeople(MAX, [{ id: "7", name: "Cas", phone: "+79001234567" }])

    const first = await store.people.scanMatches()

    expect(first.merged).toEqual([])
    expect(first.proposed).toHaveLength(3)
    expect(first.proposed.every(({ opened, signal }) => opened && signal === "phone")).toBe(true)
    const [rejected] = first.proposed
    await store.people.decideLink(rejected?.id as string, { confirm: false, by: "owner" })

    expect((await store.people.scanMatches()).proposed).toEqual([])
    const again = await store.people.scanMatches({ full: true })

    expect(again.proposed.map(({ id, opened }) => ({ id, opened }))).toEqual(
      first.proposed.slice(1).map(({ id }) => ({ id, opened: false })),
    )
    expect(again.skipped).toMatchObject([{ reason: "identity.rejected" }])
    expect(await linkProposals(store)).toHaveLength(3)
  })
})

describe("a meeting guest's typed address", () => {
  it("is proposed for the one person who has it, and the owner's confirm moves only the guest", async () => {
    const store = await open()
    await store.people.savePeople(WORK, [{ id: "contact/20", name: "Alice Example", email: "alice@example.com" }])
    const meeting = sampleMeeting()
    meeting.meeting.accountId = await store.accounts.saveAccount({ provider: "zoom", account: "me" }, { name: null })
    await store.meetings.saveMeeting(meeting)
    const alice = await uidOf(store, "bitrix24", "contact/20")

    const scan = await store.people.scanMatches()

    expect(scan.merged).toEqual([])
    expect(scan.proposed).toMatchObject([{ signal: "guest-email", opened: true }])
    expect(await uidOf(store, "example", "alice-example")).not.toBe(alice)
    await store.people.decideLink(scan.proposed[0]?.id as string, { confirm: true, by: "owner" })
    expect(await uidOf(store, "example", "alice-example")).toBe(alice)
  })
})

describe("the same name and a shared trace", () => {
  const TG: AccountKey = { provider: "telegram", account: "1" }
  const MAIL: AccountKey = { provider: "email", account: "me@example.test" }
  const nameProposals = async (store: MessageStore) =>
    (await store.people.linkProposals({ limit: 50, offset: 0 })).items.filter(({ signal }) => signal === "name")

  it("proposes two people with one name in a chat they share, and never joins them", async () => {
    const store = await open()
    await store.people.savePeople(TG, [
      { id: "1", name: "OpenWeather Team" },
      { id: "2", name: '"openweather team"' },
    ])
    await store.chats.saveChats(TG, [
      { id: "g", title: "g", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 400 },
    ])
    await store.roster.saveMembers(TG, "g", ["1", "2"])

    const scan = await store.people.scanMatches({ full: true })

    expect(scan.merged).toEqual([])
    const [proposal] = await nameProposals(store)
    expect(proposal).toMatchObject({ joins: "person", reason: expect.stringContaining("a chat they are both in") })
    expect(proposal?.evidence).toHaveLength(1)
    expect(await uidOf(store, "telegram", "1")).not.toBe(await uidOf(store, "telegram", "2"))
  })

  it("proposes on a company's domain, but not on a free mailbox or a role address", async () => {
    const store = await open()
    await store.people.savePeople(MAIL, [
      { id: "ana@acme.example", name: "Ana Diaz" },
      { id: "a.diaz@acme.example", name: "Diaz Ana" },
      { id: "bo@gmail.com", name: "Bo Lind" },
      { id: "bo.lind@gmail.com", name: "Bo Lind" },
      { id: "info@shop.example", name: "Cy Moss" },
      { id: "sales@shop.example", name: "Cy Moss" },
    ])

    await store.people.scanMatches({ full: true })

    const found = await nameProposals(store)
    expect(found).toHaveLength(1)
    expect(found[0]?.reason).toContain("acme.example")
  })

  it("leaves one name alone without a trace, and skips a name more than six people have", async () => {
    const store = await open()
    await store.people.savePeople(TG, [
      { id: "10", name: "Ivan Petrov" },
      { id: "11", name: "Petrov Ivan" },
    ])
    await store.people.savePeople(
      MAIL,
      Array.from({ length: 7 }, (_, n) => ({ id: `al${n}@acme.example`, name: "Al Common" })),
    )

    const scan = await store.people.scanMatches({ full: true })

    expect(await nameProposals(store)).toEqual([])
    expect(scan.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ signal: "name", reason: "identity.common-name" })]),
    )
  })
})
