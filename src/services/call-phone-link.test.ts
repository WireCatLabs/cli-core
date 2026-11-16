import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { meetingDetailsAnswer, meetingPeople, pull, type SourceParticipant } from "../meetings/index.js"
import { fakeMeetingSource } from "../meetings/testing/index.js"
import { type MessageStore, openStore } from "../store/store.js"
import { scopeOf } from "./business-context.js"
import { communicationsOf } from "./communications.js"
import { canonicalPersonContext } from "./person-business.js"
import { personContext } from "./person-context.js"
import { personMeetingContext } from "./person-meeting-context.js"

const CRM = { provider: "bitrix24", account: "acme.example", scope: "work" as const }
const CALLS = { provider: "pbx-example", account: "office", scope: "work" as const }

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const client = (phone: string): SourceParticipant => ({
  identityExternalId: `phone:${phone}`,
  phone,
  email: null,
  displayName: null,
  externalId: null,
  role: "client",
  joinedAt: null,
  leftAt: null,
  durationMs: null,
  sessions: null,
  metadata: null,
})

const fixture = async (contacts: { id: string; name: string; phone: string; phones?: string[] }[], called: string) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "phone-link-")), "store.db") })
  opened.push(store)
  await store.accounts.saveAccount(CRM, { name: null })
  const accountId = await store.accounts.saveAccount(CALLS, { name: null })
  await store.people.savePeople(CRM, contacts)
  const source = fakeMeetingSource({ provider: CALLS.provider, participants: async () => [client(called)] })
  await pull(source, { ...store.meetings, linkCallers: undefined }, { accountId, now: 4000 })
  const scan = await store.people.scanMatches()
  const callPerson = await store.people.personOf({ provider: CALLS.provider, id: `phone:${called}` })
  const contactPerson = await store.people.personOf({ provider: CRM.provider, id: contacts[0]?.id as string })
  return { store, accountId, scan, callPerson, contactPerson }
}

describe("a call's client and the CRM contact with that number (NEED-2600)", () => {
  it("are one person, and the call is in that person's meeting context", async () => {
    const { store, accountId, scan, callPerson, contactPerson } = await fixture(
      [{ id: "contact/20", name: "Ana Example", phone: "+7 (916) 123-45-67" }],
      "+79161234567",
    )

    expect(scan.merged).toMatchObject([{ signal: "same-phone" }])
    expect(callPerson?.uid).toBe(contactPerson?.uid)
    expect(callPerson?.identities.map(({ provider }) => provider).sort()).toEqual([CRM.provider, CALLS.provider])
    const context = await personMeetingContext(store, `person:${callPerson?.uid}`, { accountIds: [accountId] })
    expect(context.person.name).toBe("Ana Example")
    expect(context.items.map(({ reference }) => reference)).toEqual([expect.stringMatching(/^meeting:/)])
    const stored = (await store.meetings.meetings({ accountId }))[0] as { id: number }
    const person = { ref: `person:${callPerson?.uid}`, name: "Ana Example" }
    expect((await meetingDetailsAnswer(store.meetings, stored.id, accountId)).item.participants).toMatchObject([
      { name: null, person },
    ])
    expect((await meetingPeople(store.meetings, "ana", accountId)).items).toMatchObject([{ person }])
    const call = {
      ref: `meeting:${accountId}/${stored.id}`,
      meetingId: stored.id,
      account: { provider: CALLS.provider, account: CALLS.account },
      hasTranscript: true,
      people: [person.ref],
    }
    expect((await personContext(store, CRM, "Ana Example")).meetings).toMatchObject([call])
    expect((await canonicalPersonContext(store, person.ref)).meetings).toMatchObject([call])
    const touches = await communicationsOf(store, [callPerson as NonNullable<typeof callPerson>], scopeOf(undefined))
    expect(touches.counts.meetings).toBe(1)
    expect(touches.items).toMatchObject([{ kind: "meeting", ref: call.ref, people: [person.ref] }])
  })

  it("are one person when the CRM wrote the number nationally, first or among its other numbers", async () => {
    const first = await fixture([{ id: "contact/20", name: "Ana Example", phone: "8 (912) 345-67-89" }], "+79123456789")
    expect(first.scan.merged).toMatchObject([{ signal: "same-phone" }])
    expect(first.callPerson?.uid).toBe(first.contactPerson?.uid)

    const other = await fixture(
      [
        {
          id: "contact/20",
          name: "Ana Example",
          phone: "+7 495 123-45-67",
          phones: ["+7 495 123-45-67", "8 916 123-45-67"],
        },
      ],
      "+79161234567",
    )
    expect(other.scan.merged).toMatchObject([{ signal: "same-phone" }])
    expect(other.callPerson?.uid).toBe(other.contactPerson?.uid)
  })

  it("are only proposed on a landline: an office's number is everyone's who works there", async () => {
    const { scan, callPerson, contactPerson } = await fixture(
      [{ id: "contact/20", name: "Ana Example", phone: "+7 495 123-45-67" }],
      "+74951234567",
    )

    expect(scan.merged).toEqual([])
    expect(scan.proposed).toMatchObject([{ signal: "phone" }])
    expect(callPerson?.uid).not.toBe(contactPerson?.uid)
  })

  it("are left apart when two CRM contacts have the number", async () => {
    const { scan, callPerson, contactPerson } = await fixture(
      [
        { id: "contact/20", name: "Ana Example", phone: "+79161234567" },
        { id: "contact/21", name: "Bo Sample", phone: "+79161234567" },
      ],
      "+79161234567",
    )

    expect(scan.merged).toEqual([])
    expect(scan.proposed).toEqual([])
    expect(scan.skipped).toMatchObject([{ reason: "identity.shared-phone" }])
    expect(callPerson?.uid).not.toBe(contactPerson?.uid)
  })
})

describe("one mobile a CRM contact, a WhatsApp account and a call each have (BUG-774, BUG-775)", () => {
  const MOBILE = "+79161234567"
  const WA = { provider: "whatsapp", account: "1", scope: "personal" as const }
  const AMO = { provider: "amocrm", account: "other.example", scope: "work" as const }
  const crm = { provider: CRM.provider, id: "contact/20" }
  const wa = { provider: WA.provider, id: "79161234567" }
  const call = { provider: CALLS.provider, id: `phone:${MOBILE}` }

  const empty = async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "one-mobile-")), "store.db") })
    opened.push(store)
    return store
  }
  const add = {
    crm: (store: MessageStore) =>
      store.people.savePeople(CRM, [{ id: crm.id, name: "Ana Example", phone: "8 (916) 123-45-67" }]),
    wa: (store: MessageStore) => store.people.savePeople(WA, [{ id: wa.id, name: "Ana", phone: "79161234567" }]),
    call: async (store: MessageStore) => {
      const accountId = await store.accounts.saveAccount(CALLS, { name: null })
      const source = fakeMeetingSource({ provider: CALLS.provider, participants: async () => [client(MOBILE)] })
      await pull(source, { ...store.meetings, linkCallers: undefined }, { accountId, now: 4000 })
    },
  }
  const uids = async (store: MessageStore) =>
    new Set(await Promise.all([crm, wa, call].map(async (ref) => (await store.people.personOf(ref))?.uid)))

  it.each([
    ["all three, then one scan", ["crm", "wa", "call"], false],
    ["a scan after each, the CRM contact last", ["wa", "call", "crm"], true],
    ["a scan after each, the WhatsApp account last", ["crm", "call", "wa"], true],
  ] as const)("is one person without the owner: %s", async (_, order, scanEach) => {
    const store = await empty()
    for (const source of order) {
      await add[source](store)
      if (scanEach) await store.people.scanMatches()
    }
    if (!scanEach) await store.people.scanMatches()
    expect((await uids(store)).size).toBe(1)
    expect((await store.people.linkProposals({ limit: 10, offset: 0 })).items).toEqual([])
  })

  it("joins over a proposal still open for the pair, once a WhatsApp account has the number too", async () => {
    const store = await empty()
    await add.crm(store)
    await store.people.savePeople(AMO, [{ id: "contact/9", name: "Ana E.", phone: MOBILE }])
    await store.people.scanMatches()
    expect((await store.people.linkProposals({ limit: 10, offset: 0 })).items).toHaveLength(1)

    await add.wa(store)
    const scan = await store.people.scanMatches()

    expect(scan.merged).toHaveLength(2)
    const amo = await store.people.personOf({ provider: AMO.provider, id: "contact/9" })
    expect(amo?.uid).toBe((await store.people.personOf(crm))?.uid)
    expect((await store.people.personOf(wa))?.uid).toBe(amo?.uid)
    expect((await store.people.linkProposals({ limit: 10, offset: 0 })).items).toEqual([])
  })

  it("is strong evidence for an agent's link while all three are still apart", async () => {
    const store = await empty()
    for (const source of ["crm", "wa", "call"] as const) await add[source](store)

    const done = await store.people.agentLink({ identity: crm, with: wa, bot: "claude-code", reason: "", apply: true })

    expect(done).toMatchObject({ outcome: "merged", evidence: { strong: true } })
    expect(done.evidence.facts[0]).toMatchObject({ others: 1, strong: true, weak: null })
  })
})

describe("a sync that saved a call's client, with no people scan run (memo absent)", () => {
  it("**links the call to the CRM contact by the number**, and leaves the scan's other rules and cursor to the scan", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "phone-link-sync-")), "store.db") })
    opened.push(store)
    await store.accounts.saveAccount(CRM, { name: null })
    const accountId = await store.accounts.saveAccount(CALLS, { name: null })
    await store.people.savePeople(CRM, [
      { id: "contact/20", name: "Ana Example", phone: "8 (916) 123-45-67" },
      { id: "contact/30", name: "Bo Sample", phone: "+7 495 000-00-01" },
      { id: "contact/31", name: "Bo Sample", phone: "+7 495 000-00-02" },
    ])
    const source = fakeMeetingSource({ provider: CALLS.provider, participants: async () => [client("+79161234567")] })

    await pull(source, store.meetings, { accountId, now: 4000 })

    const caller = await store.people.personOf({ provider: CALLS.provider, id: "phone:+79161234567" })
    const contact = await store.people.personOf({ provider: CRM.provider, id: "contact/20" })
    expect(caller?.uid).toBe(contact?.uid)
    const bo = await store.people.personOf({ provider: CRM.provider, id: "contact/30" })
    expect((await store.people.personOf({ provider: CRM.provider, id: "contact/31" }))?.uid).not.toBe(bo?.uid)
    expect((await store.people.scanMatches()).full).toBe(true)
  })
})
