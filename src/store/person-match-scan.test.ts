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
    expect((await linkProposals(store)).items).toEqual([])
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

  it("starts hr@ below info@: one person often reads hr@ alone", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [
      { id: "5", name: "Ana Diaz", email: "info@shop.example" },
      { id: "6", name: "Eva Ruiz", email: "hr@shop.example" },
    ])
    await store.people.savePeople(MAX, [
      { id: "7", name: "Bo Lind", email: "info@shop.example" },
      { id: "8", name: "Lu Park", email: "hr@shop.example" },
    ])

    await store.people.scanMatches({ full: true })

    const found = await sharedProposals(store)
    expect(found.map(({ mailbox, score }) => [mailbox, score]).sort()).toEqual([
      ["hr@shop.example", 0.05],
      ["info@shop.example", 0.1],
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

describe("a company's mailbox, the owner's third answer (NEED-2528)", () => {
  const sharedPair = async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana Diaz", email: "info@shop.example" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Bo Lind", email: "info@shop.example" }])
    await store.people.scanMatches({ full: true })
    const [proposal] = (await store.people.linkProposals({ limit: 50, offset: 0 })).items
    return { store, id: proposal?.id as string }
  }
  const holders = async () =>
    (await raw())
      .prepare(
        "SELECT o.name, oi.method, oi.author FROM organization_identities oi JOIN organizations o " +
          "ON o.id = oi.organization_id JOIN identities i ON i.id = oi.identity_id WHERE i.provider = 'email' " +
          "AND i.external_id = 'info@shop.example'",
      )
      .all()

  it("gives the address to a new company of its domain, joins nobody, and is not proposed again", async () => {
    const { store, id } = await sharedPair()

    const decided = await store.people.decideLink(id, { confirm: false, by: "owner", company: {} })
    const rescan = await store.people.scanMatches({ full: true })

    expect(decided).toMatchObject({ status: "rejected", result: { dismissed: true, mailbox: "info@shop.example" } })
    expect(await holders()).toEqual([{ name: "shop.example", method: "proposal", author: "owner" }])
    expect(await uidOf(store, "telegram", "5")).not.toBe(await uidOf(store, "max", "7"))
    expect(rescan.proposed).toEqual([])
    expect((await store.people.linkProposals({ limit: 50, offset: 0 })).items).toEqual([])
  })

  it("with all closes every pair on the address in one decision; without it only the pair asked about", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana Diaz", email: "info@shop.example" }])
    await store.people.savePeople(MAX, [
      { id: "7", name: "Bo Lind", email: "info@shop.example" },
      { id: "8", name: "Cy Moss", email: "info@shop.example" },
    ])
    await store.people.scanMatches({ full: true })
    const listed = (await store.people.linkProposals({ limit: 50, offset: 0 })).items
    const [first, ...rest] = listed.map(({ id }) => id) as [string, ...string[]]

    await store.people.decideLink(first, { confirm: false, by: "owner", company: {} })
    const left = (await store.people.linkProposals({ limit: 50, offset: 0 })).items.map(({ id }) => id)
    const decided = await store.people.decideLink(rest[0] as string, {
      confirm: false,
      by: "owner",
      company: { all: true },
    })
    const rescan = await store.people.scanMatches({ full: true })

    expect(listed).toHaveLength(3)
    expect(new Set(listed.map(({ candidates }) => candidates.length))).toEqual(new Set([3]))
    expect(new Set(listed.map(({ mailbox }) => mailbox))).toEqual(new Set(["info@shop.example"]))
    expect(left.sort()).toEqual([...rest].sort())
    expect(decided.result).toMatchObject({ closed: [rest[0], rest[1]] })
    expect((await store.people.linkProposals({ limit: 50, offset: 0 })).items).toEqual([])
    expect(rescan.proposed).toEqual([])
    expect(rescan.merged).toEqual([])
  })

  it("gives it to the organization the owner names, or to the one that holds the company's domain", async () => {
    const { store, id } = await sharedPair()
    const shop = await store.knowledge.addOrganization({ kind: "company", name: "Shop" })

    const decided = await store.people.decideLink(id, {
      confirm: false,
      by: "owner",
      company: { organization: Number(shop.id) },
    })

    expect(decided.result).toMatchObject({ organization: `organization:${shop.id}` })
    expect(await holders()).toEqual([{ name: "Shop", method: "proposal", author: "owner" }])
  })

  it("is refused to an agent, on a proposal that is not about a shared mailbox, and on an unknown organization", async () => {
    const { store, id } = await sharedPair()
    await store.people.savePeople(MAX, [{ id: "8", name: "Cas" }])
    const agents = await store.people.proposeLink({
      identity: { provider: "max", id: "7" },
      with: { provider: "max", id: "8" },
      signal: "agent",
      by: { bot: "helper" },
    })

    await expect(
      store.people.decideLink(id, { confirm: false, by: { bot: "helper", reason: "same inbox" }, company: {} }),
    ).rejects.toMatchObject({ code: "permission_error" })
    await expect(
      store.people.decideLink(agents.id, { confirm: false, by: "owner", company: {} }),
    ).rejects.toMatchObject({ details: { reason: "identity.not-shared" } })
    await expect(
      store.people.decideLink(id, { confirm: false, by: "owner", company: { organization: 999 } }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(await holders()).toEqual([])
  })
})

describe("a company's address on a match that is not about a shared mailbox (Desktop #331)", () => {
  it("gives the address the owner names to the company, and keeps the two people apart", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Kai Berg", email: "b2b@telco.example" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Kai Berg", email: "kai@gmail.com" }])
    const proposed = await store.people.proposeLink({
      identity: { provider: "max", id: "7" },
      with: { provider: "telegram", id: "5" },
      signal: "agent",
      by: { bot: "helper" },
    })

    await expect(
      store.people.decideLink(proposed.id, { confirm: false, by: "owner", company: {} }),
    ).rejects.toMatchObject({ details: { reason: "identity.not-shared", candidates: ["b2b@telco.example"] } })
    await expect(
      store.people.decideLink(proposed.id, { confirm: false, by: "owner", company: { mailbox: "kai@gmail.com" } }),
    ).rejects.toMatchObject({ details: { reason: "identity.not-shared" } })
    const decided = await store.people.decideLink(proposed.id, {
      confirm: false,
      by: "owner",
      company: { mailbox: "email:b2b@telco.example", name: "Telco" },
    })

    expect(decided).toMatchObject({ status: "rejected", result: { dismissed: true, mailbox: "b2b@telco.example" } })
    expect(await uidOf(store, "telegram", "5")).not.toBe(await uidOf(store, "max", "7"))
    const held = (await raw())
      .prepare(
        "SELECT o.name FROM organization_identities oi JOIN organizations o ON o.id = oi.organization_id " +
          "JOIN identities i ON i.id = oi.identity_id WHERE i.provider = 'email' AND i.external_id = 'b2b@telco.example'",
      )
      .all()
    expect(held).toEqual([{ name: "Telco" }])
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
    expect((await linkProposals(store)).items).toHaveLength(3)
    expect((await store.people.linkProposals({ limit: 50, offset: 0 })).items.map(({ score }) => score)).toEqual([
      0.4, 0.4,
    ])
  })
})

describe("scores on one scale (NEED-2529)", () => {
  const CRM: AccountKey = { provider: "bitrix24", account: "acme.example" }
  const CARDS: AccountKey = { provider: "amocrm", account: "acme" }
  const crmPhonePair = async () => {
    const store = await open()
    await store.people.savePeople(CRM, [{ id: "c1", name: "Kai B", phone: "+7 900 555-00-00" }])
    await store.people.savePeople(CARDS, [{ id: "c2", name: "Kai C", phone: "+79005550000" }])
    return store
  }

  it("gives a phone two CRM contacts alone have 0.7, and lists it before a shared mailbox's 0.1", async () => {
    const store = await crmPhonePair()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana Diaz", email: "info@shop.example" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Bo Lind", email: "info@shop.example" }])

    const scan = await store.people.scanMatches({ full: true })
    const listed = (await store.people.linkProposals({ order: "score", limit: 50, offset: 0 })).items

    expect(scan.merged).toEqual([])
    expect(listed.map(({ signal, score }) => [signal, score])).toEqual([
      ["phone", 0.7],
      ["email", 0.1],
    ])
  })

  it("fills the score of an open rule proposal made before scores, and leaves a decided one as it was", async () => {
    const store = await crmPhonePair()
    await store.people.savePeople(CRM, [{ id: "c3", name: "Lu D", phone: "+7 900 555-11-11" }])
    await store.people.savePeople(CARDS, [{ id: "c4", name: "Lu E", phone: "+79005551111" }])
    await store.people.scanMatches({ full: true })
    const [open, decided] = (await linkProposals(store)).items.map(({ id }) => id)
    await store.people.decideLink(decided as string, { confirm: false, by: "owner" })
    const database = await raw()
    database.prepare("UPDATE proposed_actions SET payload = json_set(payload, '$.score', json('null'))").run()

    await store.people.scanMatches({ full: true })
    const scores = Object.fromEntries(
      (await store.people.linkProposals({ status: "all", limit: 50, offset: 0 })).items.map(({ id, score }) => [
        id,
        score,
      ]),
    )

    expect(scores).toEqual({ [open as string]: 0.7, [decided as string]: null })
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
    expect((await store.people.linkProposals({ limit: 50, offset: 0 })).items).toMatchObject([{ score: 0.5 }])
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
    expect(proposal).toMatchObject({
      joins: "person",
      score: 0.5,
      reason: expect.stringContaining("a chat they are both in"),
    })
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
    expect(found[0]?.score).toBe(0.5)
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

describe("the same company in the CRM", () => {
  it("proposes two CRM contacts of one name whom the CRM puts in one company, and not two without one", async () => {
    const store = await open()
    await store.crm.saveOrganizations(WORK, [{ externalId: "c1", name: "Acme Ltd" }])
    const atAcme = [{ externalId: "c1" }]
    await store.crm.savePeople(WORK, [
      { externalId: "1", name: "Kai Berg", organizations: atAcme },
      { externalId: "2", name: "Kai Berg", organizations: atAcme },
      { externalId: "3", name: "Lu Park" },
      { externalId: "4", name: "Lu Park" },
    ])

    await store.people.scanMatches({ full: true })

    const found = (await store.people.linkProposals({ limit: 50, offset: 0 })).items.filter(
      ({ signal }) => signal === "name",
    )
    expect(found).toMatchObject([{ score: 0.5, reason: "same name «Kai Berg» and the same company in the CRM" }])
    expect(found[0]?.evidence).toEqual([expect.stringMatching(/^organization:\d+$/)])
  })
})

describe("one name in private chats on two messengers", () => {
  const WA: AccountKey = { provider: "whatsapp", account: "3" }
  const dialog = async (store: MessageStore, account: AccountKey, id: string, answered: boolean) => {
    await store.chats.saveChats(account, [
      { id, title: id, kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
    ])
    const message = (n: string, outgoing: boolean) => ({
      ...{ id: n, chatId: id, senderId: outgoing ? null : id, senderName: null, editedAt: null, outgoing },
      ...{ timestamp: new Date(Date.UTC(2026, 9, 1, 10, Number(n))).toISOString(), text: "synthetic" },
      ...{ attachments: [], replyTo: null, forwardedFrom: null, reactions: null },
    })
    await store.messages.saveMessages(account, id, [message("1", false), ...(answered ? [message("2", true)] : [])], {
      via: "history",
    })
  }

  it("is proposed at 0.3 when the owner talks to both, and not when one side never got an answer", async () => {
    const store = await open()
    await store.people.savePeople(WA, [
      { id: "555@lid", name: "Mila" },
      { id: "556@lid", name: "Rus" },
    ])
    await store.people.savePeople(PERSONAL, [
      { id: "77", name: "Mila" },
      { id: "78", name: "Rus" },
    ])
    await dialog(store, WA, "555@lid", true)
    await dialog(store, PERSONAL, "77", true)
    await dialog(store, WA, "556@lid", true)
    await dialog(store, PERSONAL, "78", false)

    await store.people.scanMatches({ full: true })

    const found = (await store.people.linkProposals({ limit: 50, offset: 0 })).items
    expect(found).toMatchObject([
      { signal: "name", score: 0.3, reason: "same name «Mila» in private chats on whatsapp and telegram" },
    ])
  })
})

describe("a person on one of the owner's own accounts", () => {
  it("takes the fullest name of their other identities, not the account's label", async () => {
    const store = await open()
    await store.accounts.saveAccount(MAX, { name: "Mila 2" })
    await store.people.savePeople(MAX, [{ id: "2", name: "Mila 2" }])
    await store.people.savePeople(PERSONAL, [{ id: "77", name: "Mila" }])
    const mail: AccountKey = { provider: "email", account: "me@shop.example" }
    await store.people.savePeople(mail, [
      { id: "mila@home.example", name: "Mila Orlova" },
      { id: "m.orlova@work.example", name: "Mila K. Orlova" },
    ])
    const owner = { method: "manual", by: "owner" }
    for (const other of [
      { provider: "telegram", id: "77" },
      { provider: "email", id: "mila@home.example" },
      { provider: "email", id: "m.orlova@work.example" },
    ])
      await store.people.linkIdentities({ provider: "max", id: "2" }, other, owner)

    await store.people.scanMatches({ full: true })

    const person = await store.people.personOf({ provider: "max", id: "2" })
    expect(person?.name).toBe("Mila K. Orlova")
  })
})
