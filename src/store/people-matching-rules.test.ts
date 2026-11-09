import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { IDENTITY_LINK_KIND } from "./identity-links.js"
import { openCache } from "./open.js"
import { storedPhone } from "./sqlite/person-matcher.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const WORK: AccountKey = { provider: "bitrix24", account: "acme.example", scope: "work" }
const OTHER_CRM: AccountKey = { provider: "amocrm", account: "acme", scope: "work" }
const PERSONAL: AccountKey = { provider: "telegram", account: "1", scope: "personal" }
const MAX: AccountKey = { provider: "max", account: "2" }
const agent = { bot: "claude-code" }
const manual = { method: "manual", by: "owner" }
const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

let path = ""
const open = async () => {
  path = join(mkdtempSync(join(tmpdir(), "people-rules-")), "store.db")
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
const openLinks = (store: MessageStore) =>
  store.proposedActions.list({ kinds: [IDENTITY_LINK_KIND], status: "proposed" })

/** Makes the person `uid` the owner, as an older store can have it: the owner's row need not be the first person. */
const makeOwner = async (uid: string) => {
  const database = await raw()
  database.prepare("UPDATE persons SET owner = 0").run()
  database.prepare("UPDATE persons SET owner = 1 WHERE id = ?").run(Number(uid))
}

const ownerRefs = async (store: MessageStore) =>
  (await store.people.owner())?.identities.map(({ provider, id }) => `${provider}:${id}`).sort()

describe("a stored phone", () => {
  it("is read as international bare digits only from a messenger, never from a CRM", () => {
    expect(storedPhone("79001234567", "telegram")).toBe("+79001234567")
    expect(storedPhone("4155550100", "bitrix24")).toBeUndefined()
    expect(storedPhone("+1 (415) 555-0100", "bitrix24")).toBe("+14155550100")
  })

  it("never joins a CRM's bare national number with a messenger's number", async () => {
    const store = await open()
    await store.people.savePeople(WORK, [{ id: "contact/1", name: "US client", phone: "4155550100" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Someone", phone: "+41 55 550 100" }])

    const scan = await store.people.scanMatches()

    expect(scan.merged).toEqual([])
    expect(await uidOf(store, "bitrix24", "contact/1")).not.toBe(await uidOf(store, "max", "7"))
  })
})

describe("the owner's person", () => {
  it("keeps every identity when the owner confirms a scan proposal that names it", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "9", name: "Slava", phone: "79001234567" }])
    await store.people.savePeople(WORK, [
      { id: "contact/1", name: "Assistant", phone: "+7 900 123-45-67" },
      { id: "contact/2", name: "Office", phone: "+7 900 123 45 67" },
    ])
    const me = await uidOf(store, "telegram", "9")
    await makeOwner(me)
    await store.people.scanMatches()
    const withMe = (await openLinks(store)).find(({ payload }) =>
      (payload as { persons: string[] }).persons.includes(me),
    )

    await store.people.decideLink(withMe?.id as string, { confirm: true, by: "owner" })

    expect((await store.people.owner())?.uid).toBe(me)
    expect(await uidOf(store, "telegram", "9")).toBe(me)
  })

  it("keeps the owner's CRM contact when it gains an address at import", async () => {
    const store = await open()
    await store.people.savePeople(WORK, [{ id: "contact/1", name: "Slava" }])
    const me = await uidOf(store, "bitrix24", "contact/1")
    await makeOwner(me)

    await store.people.savePeople(WORK, [{ id: "contact/1", name: "Slava", email: "slava@acme.example" }])

    expect((await store.people.owner())?.uid).toBe(me)
    expect(await ownerRefs(store)).toEqual(["bitrix24:contact/1", "email:slava@acme.example"])
  })

  it("keeps its uid when the owner links one of its identities to another person", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "9", name: "Slava" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Slava M" }])
    const me = await uidOf(store, "telegram", "9")
    await makeOwner(me)

    await store.people.linkIdentities(
      { provider: "max", id: "7" },
      { provider: "telegram", id: "9" },
      {
        method: "manual",
        by: "owner",
      },
    )

    expect(await ownerRefs(store)).toEqual(["max:7", "telegram:9"])
    expect((await store.people.owner())?.uid).toBe(me)
  })
})

describe("a phone two people share (NEED-2445, safe option)", () => {
  it("is a proposal when no messenger vouches for the number", async () => {
    const store = await open()
    await store.people.savePeople(WORK, [{ id: "contact/1", name: "Ana", phone: "+7 900 123-45-67" }])
    await store.people.savePeople(OTHER_CRM, [{ id: "contact/9", name: "Ana B", phone: "+79001234567" }])

    const scan = await store.people.scanMatches()

    expect(scan.merged).toEqual([])
    expect(scan.proposed).toMatchObject([{ signal: "phone", opened: true }])
  })

  it("left after the owner confirmed one pair of three stays a proposal", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana", phone: "79001234567" }])
    await store.people.savePeople(WORK, [{ id: "contact/20", name: "Ana Example", phone: "+79001234567" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Bea", phone: "79001234567" }])
    await store.people.scanMatches()
    const ana = [await uidOf(store, "telegram", "5"), await uidOf(store, "bitrix24", "contact/20")]
    const pair = (await openLinks(store)).find(({ payload }) =>
      ana.every((uid) => (payload as { persons: string[] }).persons.includes(uid)),
    )
    await store.people.decideLink(pair?.id as string, { confirm: true, by: "owner" })

    const second = await store.people.scanMatches()

    expect(second.merged).toEqual([])
    expect(await uidOf(store, "max", "7")).not.toBe(await uidOf(store, "telegram", "5"))
    expect(await openLinks(store)).toHaveLength(1)
  })
})

describe("an address more than two people share (NEED-2446, safe option)", () => {
  it("joins nobody, at import or in a scan", async () => {
    const store = await open()
    await store.people.savePeople(
      WORK,
      Array.from({ length: 12 }, (_, n) => ({
        id: `contact/${n}`,
        name: `Employee ${n}`,
        email: "office@acme.example",
      })),
    )

    const scan = await store.people.scanMatches()

    const people = new Set<string>()
    for (let n = 0; n < 12; n++) people.add(await uidOf(store, "bitrix24", `contact/${n}`))
    expect(people.size).toBe(12)
    expect(scan.merged).toEqual([])
  })

  it("opens a proposal for each pair when three people have it", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Ana B" }])
    await store.people.savePeople(WORK, [{ id: "contact/1", name: "Ana C" }])
    ;(await raw()).prepare("UPDATE identities SET email = 'ana@example.com' WHERE provider <> 'email'").run()

    const scan = await store.people.scanMatches()

    expect(scan.merged).toEqual([])
    expect(scan.proposed).toHaveLength(3)
  })
})

describe("the owner's rejection (NEED-2444)", () => {
  const rejected = async (store: MessageStore) => {
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Ana B" }])
    const proposal = await store.people.proposeLink({
      identity: { provider: "telegram", id: "5" },
      with: { provider: "max", id: "7" },
      signal: "agent",
      by: agent,
      reason: "same name",
    })
    await store.people.decideLink(proposal.id, { confirm: false, by: "owner" })
  }
  const shareAddress = async () =>
    (await raw()).prepare("UPDATE identities SET email = 'ana@example.com' WHERE provider IN ('telegram', 'max')").run()

  it("holds against the same evidence: no join and no proposal", async () => {
    const store = await open()
    await rejected(store)

    await expect(
      store.people.proposeLink({
        identity: { provider: "max", id: "7" },
        with: { provider: "telegram", id: "5" },
        signal: "agent",
        by: agent,
      }),
    ).rejects.toMatchObject({ details: { reason: "identity.rejected" } })
    expect(await openLinks(store)).toEqual([])
  })

  it("proposes the pair again on a new signal in a scan, and once that is rejected too, never a third time", async () => {
    const store = await open()
    await rejected(store)
    await shareAddress()

    const scan = await store.people.scanMatches()

    expect(await uidOf(store, "telegram", "5")).not.toBe(await uidOf(store, "max", "7"))
    expect(scan.merged).toEqual([])
    expect(scan.proposed).toMatchObject([{ signal: "email", opened: true }])
    expect((await store.people.scanMatches({ full: true })).proposed).toMatchObject([{ opened: false }])
    await store.people.decideLink(scan.proposed[0]?.id as string, { confirm: false, by: "owner" })

    const again = await store.people.scanMatches({ full: true })

    expect(again.proposed).toEqual([])
    expect(again.skipped).toMatchObject([{ reason: "identity.rejected" }])
    expect(await openLinks(store)).toEqual([])
  })

  it("proposes the pair again on a new identity", async () => {
    const store = await open()
    await rejected(store)
    await store.people.savePeople(MAX, [{ id: "8", name: "Ana work" }])
    await store.people.linkIdentities({ provider: "max", id: "7" }, { provider: "max", id: "8" }, manual)

    const proposal = await store.people.proposeLink({
      identity: { provider: "telegram", id: "5" },
      with: { provider: "max", id: "8" },
      signal: "agent",
      by: agent,
    })

    expect(proposal.status).toBe("proposed")
  })

  it("proposes the pair again on the same address at import, and a later scan does not propose it a third time", async () => {
    const store = await open()
    await rejected(store)

    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana", email: "ana@example.com" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Ana B", email: "ana@example.com" }])

    expect(await uidOf(store, "telegram", "5")).not.toBe(await uidOf(store, "max", "7"))
    const [opened] = await openLinks(store)
    expect(opened?.payload).toMatchObject({ signal: "email" })
    await store.people.decideLink(String(opened?.id), { confirm: false, by: "owner" })

    const scan = await store.people.scanMatches({ full: true })

    expect(scan.proposed).toEqual([])
    expect(scan.merged).toEqual([])
    expect(await openLinks(store)).toEqual([])
  })

  it("never proposes a pair the owner separated, even on new evidence", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Ana B" }])
    await store.people.linkIdentities({ provider: "telegram", id: "5" }, { provider: "max", id: "7" }, manual)
    await store.people.unlinkIdentity({ provider: "max", id: "7" }, manual)
    await shareAddress()

    const scan = await store.people.scanMatches()

    expect(scan.proposed).toEqual([])
    expect(scan.skipped).toMatchObject([{ reason: "identity.separated" }])
    expect(await openLinks(store)).toEqual([])
  })
})

describe("a role address", () => {
  it("two people share is proposed, never joined, at import or in a scan", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana", email: "info@x.com" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Bea", email: "Info@X.com" }])

    const scan = await store.people.scanMatches()

    expect(await uidOf(store, "telegram", "5")).not.toBe(await uidOf(store, "max", "7"))
    expect(scan.merged).toEqual([])
    expect(scan.proposed).toMatchObject([{ signal: "email", opened: true }])
  })

  it("from the no-reply family joins and proposes no one", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana", email: "noreply@x.com" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Bea", email: "no_reply@x.com" }])
    await store.people.savePeople(OTHER_CRM, [{ id: "9", name: "Cas", email: "noreply@x.com" }])

    const scan = await store.people.scanMatches()

    expect(scan.merged).toEqual([])
    expect(scan.proposed).toEqual([])
    expect(await openLinks(store)).toEqual([])
  })

  it("is the whole local part only: a personal address that contains a role word still joins", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ivan", email: "ivan.info@x.com" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Ivan B", email: "ivan.info@x.com" }])

    expect(await uidOf(store, "telegram", "5")).toBe(await uidOf(store, "max", "7"))
  })
})

describe("a proposal whose people changed", () => {
  it("is closed once a scan joins the two people by their address", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Ana B" }])
    await store.people.proposeLink({
      identity: { provider: "telegram", id: "5" },
      with: { provider: "max", id: "7" },
      signal: "agent",
      by: agent,
      reason: "same name",
    })
    ;(await raw())
      .prepare("UPDATE identities SET email = 'ana@example.com' WHERE provider IN ('telegram', 'max')")
      .run()

    const scan = await store.people.scanMatches()

    expect(scan.merged).toHaveLength(1)
    expect(await openLinks(store)).toEqual([])
  })

  it("keeps a phone pair it names a proposal, never an automatic join", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Ana B" }])
    const proposal = await store.people.proposeLink({
      identity: { provider: "telegram", id: "5" },
      with: { provider: "max", id: "7" },
      signal: "agent",
      by: agent,
      reason: "same name",
    })
    ;(await raw()).prepare("UPDATE identities SET phone = '79001234567' WHERE provider IN ('telegram', 'max')").run()

    const scan = await store.people.scanMatches()

    expect(scan.merged).toEqual([])
    expect(scan.proposed).toMatchObject([{ id: proposal.id, opened: false }])
  })

  it("follows a merge that added an identity to one side, so the owner can still confirm it", async () => {
    const store = await open()
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana" }])
    await store.people.savePeople(MAX, [
      { id: "7", name: "Ana B" },
      { id: "8", name: "Ana work" },
    ])
    const proposal = await store.people.proposeLink({
      identity: { provider: "telegram", id: "5" },
      with: { provider: "max", id: "7" },
      signal: "agent",
      by: agent,
      reason: "same name",
    })
    await store.people.linkIdentities(
      { provider: "max", id: "7" },
      { provider: "max", id: "8" },
      {
        method: "manual",
        by: "owner",
      },
    )

    await store.people.scanMatches()
    await store.people.decideLink(proposal.id, { confirm: true, by: "owner" })

    expect(await uidOf(store, "telegram", "5")).toBe(await uidOf(store, "max", "8"))
  })

  it("is deleted with an identity an account purge erases", async () => {
    const store = await open()
    await store.accounts.saveAccount(MAX, { name: null })
    await store.people.savePeople(PERSONAL, [{ id: "5", name: "Ana" }])
    await store.people.savePeople(MAX, [{ id: "7", name: "Ana B", phone: "+79001234567" }])
    await store.people.proposeLink({
      identity: { provider: "telegram", id: "5" },
      with: { provider: "max", id: "7" },
      signal: "agent",
      by: agent,
      reason: "same name",
    })

    await store.accounts.purge(MAX)

    expect(await store.people.personOf({ provider: "max", id: "7" })).toBeUndefined()
    expect(await store.proposedActions.list({ kinds: [IDENTITY_LINK_KIND] })).toEqual([])
  })
})
