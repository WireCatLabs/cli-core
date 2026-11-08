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

  it("brings a contact with the owner's number to the owner, never the owner to the contact", async () => {
    const store = await open()
    await store.people.savePeople(WORK, [{ id: "contact/20", name: "Slava Example", phone: "+7 900 123-45-67" }])
    await store.people.savePeople(PERSONAL, [{ id: "9", name: "Slava", phone: "79001234567" }])
    const me = { uid: await uidOf(store, "telegram", "9") }
    const database = await raw()
    database.prepare("UPDATE persons SET owner = 0").run()
    database.prepare("UPDATE persons SET owner = 1 WHERE id = ?").run(Number(me.uid))
    expect(Number(me.uid)).toBeGreaterThan(Number(await uidOf(store, "bitrix24", "contact/20")))

    await store.people.scanMatches()

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

  it("that three people share proposes each pair once, and a rejected pair stays rejected", async () => {
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

    const again = await store.people.scanMatches()

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
