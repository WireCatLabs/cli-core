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

  it("names test data: the seed's people together, and an address at a reserved domain", async () => {
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

    expect(found.items.map(({ reason, identities }) => [reason, identities.map(({ identity }) => identity)])).toEqual([
      ["test-data", ["whatsapp:11"]],
      ["test-data", ["whatsapp:12"]],
      ["test-data", ["bitrix24:c/9", "email:x@demo.test"]],
    ])
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
