import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AccountKey, openStore } from "./store.js"

const OWN: AccountKey = { provider: "telegram", account: "1", scope: "personal" }
const MAX: AccountKey = { provider: "max", account: "2", scope: "personal" }
const MAIL: AccountKey = { provider: "email", account: "me@mail.example", scope: "personal" }
const CRM: AccountKey = { provider: "bitrix24", account: "acme.example", scope: "work" }
const WA: AccountKey = { provider: "whatsapp", account: "3", scope: "personal" }
const tg = (id: string) => ({ provider: "telegram", id })
const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const open = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "person-doubts-")), "store.db") })
  handles.push(store)
  await store.people.savePeople(OWN, [{ id: "1", name: "Aleksei Ivanov" }])
  await store.accounts.saveAccount(OWN, { name: null })
  return store
}

const page = { limit: 50, offset: 0 }

describe("people in doubt (IDEA-270)", () => {
  it("names an identity under another name on the owner's person, with the unmerge that takes it off", async () => {
    const store = await open()
    await store.people.savePeople(MAX, [{ id: "2", name: "Svetlana 2" }])
    await store.people.savePeople(OWN, [{ id: "8", name: "Иванов Алексей" }])
    await store.people.linkIdentities(tg("1"), { provider: "max", id: "2" }, { method: "account", by: "rules" })
    await store.people.linkIdentities(tg("1"), tg("8"), { method: "account", by: "rules" })
    const owner = (await store.people.owner())?.uid as string
    const from = (await store.people.merges(owner)).find(({ identities }) => identities[0]?.id === "2")?.from

    const found = await store.people.doubts(page)

    expect(found.items).toEqual([
      expect.objectContaining({
        person: `person:${owner}`,
        owner: true,
        reason: "owner-other-name",
        identities: [expect.objectContaining({ identity: "max:2", method: "account", by: "rules" })],
        fix: [`people unmerge merge:${owner}-${from}`],
        moves: [{ op: "unmerge", merge: `merge:${owner}-${from}` }],
      }),
    ])
    expect(found.items[0]?.why).toMatch(/«Svetlana 2»/)
  })

  it("leaves out what the owner linked by hand", async () => {
    const store = await open()
    await store.people.savePeople(OWN, [{ id: "2", name: "Sveta" }])
    await store.people.linkIdentities(tg("1"), tg("2"), { method: "manual", by: "owner" })

    expect((await store.people.doubts(page)).items).toEqual([])
  })

  it("leaves out the identities a person held when the owner linked another to them by hand (FIND-2492)", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [
      { id: "c/1", name: "Vyacheslav Ptsarev" },
      { id: "c/2", name: "Slava" },
    ])
    const crm = (id: string) => ({ provider: "bitrix24", id })
    await store.people.linkIdentities(crm("c/2"), crm("c/1"), { method: "manual", by: "owner" })

    expect((await store.people.doubts(page)).items).toEqual([])
  })

  it("still names an identity that joined by a rule after the owner's link", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [
      { id: "c/1", name: "Vyacheslav Ptsarev" },
      { id: "c/2", name: "Slava" },
      { id: "c/3", name: "Olga Smirnova" },
    ])
    const crm = (id: string) => ({ provider: "bitrix24", id })
    await store.people.linkIdentities(crm("c/1"), crm("c/2"), { method: "manual", by: "owner" })
    await new Promise((done) => setTimeout(done, 5))
    await store.people.linkIdentities(crm("c/1"), crm("c/3"), { method: "same-email", by: "rules" })

    const [doubt] = (await store.people.doubts(page)).items

    expect(doubt?.reason).toBe("mixed-names")
    expect(doubt?.identities.map(({ identity }) => identity)).toContain("bitrix24:c/3")
  })

  it("stops naming a person the owner kept, and names only an identity that joins later (IDEA-273)", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [
      { id: "c/1", name: "Ivan Petrov" },
      { id: "c/2", name: "Olga Smirnova" },
    ])
    const crm = (id: string) => ({ provider: "bitrix24", id })
    await store.people.linkIdentities(crm("c/1"), crm("c/2"), { method: "same-email", by: "rules" })
    const [doubt] = (await store.people.doubts(page)).items
    const person = doubt?.person as string

    await expect(store.people.keep(person, { bot: "claude-code", reason: "looks fine" })).rejects.toMatchObject({
      details: { reason: "identity.owner-only" },
    })
    const kept = await store.people.keep(person, "owner")

    expect(kept.person).toBe(person)
    expect(kept.kept).toHaveLength(1)
    expect((await store.people.doubts(page)).items).toEqual([])
    await expect(store.people.keep(person, "owner")).rejects.toMatchObject({ details: { reason: "person.no-doubt" } })

    await store.people.savePeople(CRM, [{ id: "c/3", name: "Pavel Orlov" }])
    await store.people.linkIdentities(crm("c/1"), crm("c/3"), { method: "same-email", by: "rules" })
    const [again] = (await store.people.doubts(page)).items
    expect(again?.identities.map(({ identity }) => identity)).toContain("bitrix24:c/3")
    expect(again?.identities.map(({ identity }) => identity)).not.toContain(kept.kept[0])
  })

  it("still names a shared address after the owner links someone else to the person", async () => {
    const store = await open()
    await store.people.savePeople(MAIL, [{ id: "ivan@acme.ru", name: "Ivan Petrov" }])
    await store.people.savePeople(OWN, [{ id: "5", name: "Olga Smirnova", email: "ivan@acme.ru" }])
    await new Promise((done) => setTimeout(done, 5))
    await store.people.savePeople(MAX, [{ id: "9", name: "Ivan P" }])
    await store.people.linkIdentities(
      { provider: "email", id: "ivan@acme.ru" },
      { provider: "max", id: "9" },
      {
        method: "manual",
        by: "owner",
      },
    )

    expect((await store.people.doubts(page)).items).toMatchObject([{ reason: "shared-address" }])
  })

  it("keep turns down an agent's open split of the kept identities", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [
      { id: "c/1", name: "Ivan Petrov" },
      { id: "c/2", name: "Olga Smirnova" },
    ])
    const crm = (id: string) => ({ provider: "bitrix24", id })
    await store.people.linkIdentities(crm("c/1"), crm("c/2"), { method: "same-email", by: "rules" })
    const [doubt] = (await store.people.doubts(page)).items
    const split = await store.people.proposeSplit({
      identities: [crm(String(doubt?.identities.at(-1)?.identity.split(":")[1]))],
      by: { bot: "claude-code" },
      reason: "another name",
    })

    await store.people.keep(doubt?.person as string, "owner")

    expect((await store.people.splitProposals({ status: "proposed", limit: 10, offset: 0 })).items).toEqual([])
    expect((await store.people.splitProposals({ status: "rejected", limit: 10, offset: 0 })).items).toContainEqual(
      expect.objectContaining({ id: split.id }),
    )
  })

  it("leaves out a split the owner turned down", async () => {
    const store = await open()
    await store.people.savePeople(MAX, [{ id: "2", name: "Svetlana 2" }])
    await store.people.linkIdentities(tg("1"), { provider: "max", id: "2" }, { method: "account", by: "rules" })
    const proposal = await store.people.proposeSplit({
      identities: [{ provider: "max", id: "2" }],
      by: { bot: "claude-code" },
      reason: "another name",
    })
    await store.people.decideSplit(proposal.id, { confirm: false, by: "owner" })

    expect((await store.people.doubts(page)).items).toEqual([])
  })

  it("names one person with two names and nothing in common, but not when they share a phone", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [
      { id: "c/1", name: "Ivan Petrov" },
      { id: "c/2", name: "Olga Smirnova" },
      { id: "c/3", name: "Pavel Orlov", phone: "+79990001122" },
      { id: "c/4", name: "Mila Orlova", phone: "+79990001122" },
    ])
    const crm = (id: string) => ({ provider: "bitrix24", id })
    await store.people.linkIdentities(crm("c/1"), crm("c/2"), { method: "same-email", by: "rules" })
    await store.people.linkIdentities(crm("c/3"), crm("c/4"), { method: "same-phone", by: "rules" })

    const found = await store.people.doubts(page)

    expect(found.items).toEqual([expect.objectContaining({ reason: "mixed-names", fix: [] })])
    expect(found.items[0]?.identities.map(({ identity }) => identity).sort()).toEqual(["bitrix24:c/1", "bitrix24:c/2"])
  })

  it("names an identity joined by an address that a person of another name has", async () => {
    const store = await open()
    await store.people.savePeople(MAIL, [{ id: "ivan@acme.ru", name: "Ivan Petrov" }])
    await store.people.savePeople(OWN, [{ id: "5", name: "Olga Smirnova", email: "ivan@acme.ru" }])

    const [doubt] = (await store.people.doubts(page)).items

    expect(doubt).toMatchObject({ reason: "shared-address", identities: [{ identity: "telegram:5" }] })
    expect(doubt?.evidence).toContain("email:ivan@acme.ru")
    expect(doubt?.fix).toEqual([expect.stringMatching(/^people unmerge merge:\d+-\d+$/)])
  })

  it("quotes an id with a space in the command that fixes it", async () => {
    const store = await open()
    const olga = { provider: "bitrix24", id: "Olga S" }
    await store.people.savePeople(CRM, [{ id: "Olga S", name: "Olga Smirnova" }])
    await store.people.savePeople(MAIL, [{ id: "ivan@acme.ru", name: "Ivan Petrov" }])
    await store.people.savePeople(OWN, [{ id: "5", name: "Ivan Petrov" }])
    await store.people.linkIdentities(olga, tg("5"), { method: "same-phone", by: "rules" })
    // The merge brings Olga with Ivan's Telegram, so undoing it would take Ivan too: only an unlink fits.
    await store.people.linkIdentities({ provider: "email", id: "ivan@acme.ru" }, olga, {
      method: "same-email",
      by: "rules",
    })
    await store.people.savePeople(CRM, [{ id: "Olga S", name: "Olga Smirnova", email: "ivan@acme.ru" }])

    const [doubt] = (await store.people.doubts(page)).items

    const from = doubt?.person
    expect(doubt).toMatchObject({
      reason: "shared-address",
      fix: [`people unlink 'bitrix24:Olga S' --from ${from}`],
      moves: [{ op: "unlink", identities: ["bitrix24:Olga S"], from }],
    })
  })

  it("asks about the seed's names together, and hides an address at a reserved domain without asking", async () => {
    const store = await open()
    await store.people.savePeople(WA, [
      { id: "11", name: "Ann Lee" },
      { id: "12", name: "Bob Ray" },
    ])
    await store.people.savePeople(CRM, [
      { id: "c/9", name: "Real Person", email: "x@demo.test" },
      { id: "c/10", name: "Ann Lee" },
    ])

    const found = await store.people.doubts(page)

    expect(
      found.items.map(({ reason, identities, moves }) => [reason, identities.map(({ identity }) => identity), moves]),
    ).toEqual([
      ["test-data", ["whatsapp:11"], [{ op: "test-data", person: found.items[0]?.person }]],
      ["test-data", ["whatsapp:12"], [{ op: "test-data", person: found.items[1]?.person }]],
    ])
    expect(found.items[0]?.fix).toEqual([`people links resolve ${found.items[0]?.person} test`])
    expect((await store.people.similar("Real Person")).map(({ displayName }) => displayName)).toEqual([])
    const hidden = await store.people.list({ kind: "test", limit: 10 })
    expect(hidden.items.map(({ displayName }) => displayName)).toEqual(["Real Person"])
    expect(hidden.items[0]?.kindSignals).toEqual(["test-data"])
    const all = await store.people.list({ kind: "all", limit: 50 })
    expect(all.items.map(({ displayName }) => displayName)).not.toContain("Real Person")
    expect(all.total).toBe(all.items.length)
  })

  it("hides what the owner calls test data and brings back what the owner calls a real contact", async () => {
    const store = await open()
    await store.people.savePeople(WA, [
      { id: "11", name: "Ann Lee" },
      { id: "12", name: "Bob Ray" },
    ])
    await store.people.savePeople(MAIL, [{ id: "qa@demo.test", name: "Quinn Alder" }])
    const [ann, bob] = (await store.people.doubts(page)).items
    const hiddenPerson = (await store.people.list({ kind: "test", limit: 10 })).items[0]?.person as string

    await expect(
      store.people.markTestData(ann?.person as string, { bot: "claude-code", reason: "a seed name" }),
    ).rejects.toMatchObject({
      details: { reason: "identity.owner-only" },
    })
    await expect(store.people.markTestData("person:me", "owner")).rejects.toMatchObject({
      details: { reason: "person.unknown" },
    })
    expect(await store.people.markTestData(ann?.person as string, "owner")).toEqual({
      person: ann?.person,
      identities: ["whatsapp:11"],
    })
    expect(await store.people.keep(bob?.person as string, "owner")).toEqual({
      person: bob?.person,
      kept: ["whatsapp:12"],
    })
    await store.people.keep(hiddenPerson, "owner")

    expect((await store.people.doubts(page)).items).toEqual([])
    expect((await store.people.list({ kind: "test", limit: 10 })).items.map(({ person }) => person)).toEqual([
      ann?.person,
    ])
    const shown = (await store.people.list({ kind: "all", limit: 50 })).items.map(({ person }) => person)
    expect(shown).toEqual(expect.arrayContaining([bob?.person, hiddenPerson]))
    expect(shown).not.toContain(ann?.person)
  })

  it("asks to unlink test data from a person who holds a real identity too", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [{ id: "c/1", name: "Ivan Petrov" }])
    await store.people.savePeople(MAIL, [{ id: "ivan@demo.test", name: "Ivan Petrov" }])
    const crm = { provider: "bitrix24", id: "c/1" }
    await store.people.linkIdentities(
      crm,
      { provider: "email", id: "ivan@demo.test" },
      { method: "same-name", by: "rules" },
    )

    const [doubt] = (await store.people.doubts(page)).items

    expect(doubt).toMatchObject({
      reason: "test-data",
      moves: [{ op: "unlink", identities: ["email:ivan@demo.test"], from: doubt?.person }],
    })
    expect((await store.people.list({ kind: "test", limit: 10 })).items).toEqual([])
  })

  it("does not doubt a name that only repeats the identity's own mailbox", async () => {
    const store = await open()
    await store.people.savePeople(MAIL, [{ id: "zx81q@mail.ru", name: "Yarik" }])
    await store.people.savePeople({ provider: "google-drive", account: "d1", scope: "personal" }, [
      { id: "g1", name: "zx81q", email: "zx81q@mail.ru" },
    ])

    expect((await store.people.doubts(page)).items).toEqual([])
  })

  it("still doubts a first name on its own mailbox beside another name on the same address", async () => {
    const store = await open()
    await store.people.savePeople(MAIL, [{ id: "ivan@acme.ru", name: "Ivan" }])
    await store.people.savePeople(CRM, [{ id: "c/1", name: "Олег Петров", email: "ivan@acme.ru" }])

    expect((await store.people.doubts(page)).items).toMatchObject([{ reason: "shared-address" }])
  })

  it("does not doubt a short form of a name on one address, in either script", async () => {
    const store = await open()
    await store.people.savePeople(MAIL, [
      { id: "orlov@acme.ru", name: "Ярик" },
      { id: "petrov@acme.ru", name: "Bob" },
    ])
    await store.people.savePeople(CRM, [
      { id: "c/1", name: "Yaroslav Orlov", email: "orlov@acme.ru" },
      { id: "c/2", name: "Роберт Петров", email: "petrov@acme.ru" },
    ])

    expect((await store.people.doubts(page)).items).toEqual([])
  })

  it("pages, the owner first, with the total", async () => {
    const store = await open()
    await store.people.savePeople(MAX, [{ id: "2", name: "Svetlana 2" }])
    await store.people.linkIdentities(tg("1"), { provider: "max", id: "2" }, { method: "account", by: "rules" })
    await store.people.savePeople(WA, [
      { id: "11", name: "Ann Lee" },
      { id: "12", name: "Bob Ray" },
    ])

    const first = await store.people.doubts({ limit: 1, offset: 0 })
    const second = await store.people.doubts({ limit: 2, offset: 1 })

    expect(first).toMatchObject({ total: 3, hasMore: true, items: [{ owner: true }] })
    expect(second).toMatchObject({ total: 3, hasMore: false })
    expect(second.items.map(({ reason }) => reason)).toEqual(["test-data", "test-data"])
  })
})
