import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AccountKey, type MessageStore, openStore } from "./store.js"
import type { PersonRecord } from "./types.js"

const TG: AccountKey = { provider: "telegram", account: "1" }
const CRM: AccountKey = { provider: "bitrix24", account: "acme.example" }
const AMO: AccountKey = { provider: "amocrm", account: "other.example" }
const MOBILE = "+34 600 111 222"
const LANDLINE = "+34 912 345 678"
const agent = { bot: "claude-code", run: "run-1", reason: "the CRM card and the chat are the same Lena", apply: true }

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const open = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "agent-links-")), "store.db") })
  opened.push(store)
  return store
}

const tg = { provider: "telegram", id: "101" }
const crm = { provider: "bitrix24", id: "contact/7" }

const twoLenas = async (store: MessageStore, phone: string) => {
  await store.people.savePeople(TG, [{ id: tg.id, name: "Lena Fictive", phone: phone.replace(/\D/g, "") }])
  await store.people.savePeople(CRM, [{ id: crm.id, name: "Lena F.", phone }])
}

const uidOf = async (store: MessageStore, ref: { provider: string; id: string }) =>
  (await store.people.personOf(ref))?.uid as string

/** A person as the owner sees them; how each identity was last moved is the log's, not the person's. */
const seen = (person: PersonRecord | undefined) =>
  person && {
    uid: person.uid,
    name: person.name,
    displayName: person.displayName,
    mergedInto: person.mergedInto,
    identities: person.identities.map(({ method: _m, linkedBy: _b, linkedAt: _a, ...identity }) => identity),
  }

describe("an agent's link", () => {
  it("merges at once on a mobile two sources give, and the owner's undo gives both people back as they were", async () => {
    const store = await open()
    await twoLenas(store, MOBILE)
    const [a, b] = [await uidOf(store, tg), await uidOf(store, crm)]
    const note = await store.notes.addNote({ text: "Met at the harbour fair" })
    for (const uid of [a, b])
      await store.notes.addLink({ from: note.ref, to: `person:${uid}`, kind: "about", origin: "owner", by: "owner" })
    const before = [seen(await store.people.personByUid(a)), seen(await store.people.personByUid(b))]

    const done = await store.people.agentLink({ identity: tg, with: crm, ...agent })

    expect(done).toMatchObject({ outcome: "merged", evidence: { strong: true, weak: null } })
    expect(done.evidence.facts[0]).toMatchObject({
      kind: "phone",
      value: "+34600111222",
      holders: [["telegram:101"], ["bitrix24:contact/7"]],
      others: 0,
      strong: true,
    })
    const kept = done.outcome === "merged" ? done.person.slice("person:".length) : ""
    const gone = kept === a ? b : a
    const [merge] = await store.people.merges(kept)
    expect(merge).toMatchObject({
      id: `merge:${kept}-${gone}`,
      method: "agent",
      by: "agent:claude-code",
      agent: { bot: "claude-code", run: "run-1", reason: agent.reason, evidence: { strong: true } },
    })
    expect((await store.people.agentMerges({ limit: 10, offset: 0 })).items.map(({ id }) => id)).toEqual([merge?.id])
    expect((await store.people.linkProposals({ limit: 10, offset: 0 })).items).toEqual([])

    await store.people.undoMerge(kept, gone, "owner")

    expect([seen(await store.people.personByUid(a)), seen(await store.people.personByUid(b))]).toEqual(before)
    for (const uid of [a, b])
      expect((await store.notes.links({ to: `person:${uid}` })).map(({ from }) => from)).toEqual([note.ref])
    expect((await store.people.agentMerges({ limit: 10, offset: 0 })).items).toEqual([])
    await store.people.scanMatches({ full: true })
    expect([await uidOf(store, tg), await uidOf(store, crm)]).toEqual([a, b])
    await expect(store.people.agentLink({ identity: tg, with: crm, ...agent })).rejects.toMatchObject({
      details: { reason: "identity.separated" },
    })
  })

  it("waits for the owner on a landline, saying why", async () => {
    const store = await open()
    await twoLenas(store, LANDLINE)

    const done = await store.people.agentLink({ identity: crm, with: tg, ...agent })

    expect(done).toMatchObject({ outcome: "proposed", evidence: { strong: false, weak: "landline" } })
    const [row] = (await store.people.linkProposals({ limit: 10, offset: 0 })).items
    expect(row).toMatchObject({
      id: done.proposal,
      signal: "agent",
      reason: agent.reason,
      proposedBy: { type: "agent" },
    })
    expect(await store.people.agentMerges({ limit: 10, offset: 0 })).toEqual({ items: [], hasMore: false })
  })

  it("waits for the owner on a mobile only two CRMs give: a CRM's number is someone's word", async () => {
    const store = await open()
    const amo = { provider: "amocrm", id: "contact/9" }
    await store.people.savePeople(CRM, [{ id: crm.id, name: "Lena F.", phone: MOBILE }])
    await store.people.savePeople(AMO, [{ id: amo.id, name: "Lena Fictive", phone: MOBILE }])

    const done = await store.people.agentLink({ identity: crm, with: amo, ...agent })

    expect(done).toMatchObject({ outcome: "proposed", evidence: { strong: false, weak: "not-own-number" } })
  })

  it("waits for the owner when they share nothing, or when the owner's setting says agents only propose", async () => {
    const store = await open()
    await store.people.savePeople(TG, [{ id: "102", name: "Ivo Sample" }])
    await store.people.savePeople(CRM, [{ id: "contact/8", name: "Ivo Sample" }])
    const nothing = await store.people.agentLink({
      identity: { provider: "telegram", id: "102" },
      with: { provider: "bitrix24", id: "contact/8" },
      ...agent,
    })
    expect(nothing.evidence).toMatchObject({ strong: false, weak: "nothing-shared", facts: [] })

    await twoLenas(store, MOBILE)
    const held = await store.people.agentLink({ identity: tg, with: crm, ...agent, apply: false })
    expect(held).toMatchObject({ outcome: "proposed", evidence: { strong: false, weak: "propose-only" } })
    expect(held.evidence.facts[0]).toMatchObject({ strong: true })
  })

  it("is never an owner's move, even for an agent named owner", async () => {
    const store = await open()
    await twoLenas(store, MOBILE)
    await expect(store.people.agentLink({ identity: tg, with: crm, ...agent, bot: "owner" })).rejects.toMatchObject({
      details: { reason: "identity.agent-unnamed" },
    })
  })
})

describe("link evidence", () => {
  it("is read for many pairs at once", async () => {
    const store = await open()
    await twoLenas(store, MOBILE)
    const [a, b] = [await uidOf(store, tg), await uidOf(store, crm)]
    const [one] = await store.people.linkEvidence([[`person:${a}`, `person:${b}`]])
    expect(one).toMatchObject({ persons: [`person:${a}`, `person:${b}`], strong: true })
  })
})
