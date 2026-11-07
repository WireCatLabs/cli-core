import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { snakeKeys } from "../cli/envelope.js"
import { ACME_NOW, ACME_TELEGRAM, acmeScenario } from "../crm/testing/index.js"
import { ENTITIES } from "../entities/index.js"
import { type MessageStore, openStore } from "../store/store.js"
import { organizationsInCategory } from "./business-context.js"
import { dealBrief, dealContext } from "./deal-context.js"
import { organizationContext } from "./organization-context.js"
import { canonicalPersonContext } from "./person-business.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const scenario = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "business-")), "store.db") })
  stores.push(store)
  return acmeScenario(store)
}

const valid = (entity: keyof typeof ENTITIES, answer: unknown) => {
  const parsed = v.safeParse(ENTITIES[entity] as v.GenericSchema, snakeKeys(answer))
  expect(parsed.issues?.map((issue) => `${v.getDotPath(issue)}: ${issue.message}`)).toBeUndefined()
}

const standings = (one: { roles: { role: string | null; standing: string }[] } | undefined) =>
  one?.roles.map(({ role, standing }) => `${role}:${standing}`)

describe("organization context", () => {
  it("lists Acme's people and deals once each, with each role's standing, and Northstar as its supplier", async () => {
    const { store, refs } = await scenario()
    await store.knowledge.relate(null, {
      from: refs.bob,
      to: refs.acme,
      kind: "member-of",
      role: "manager",
      by: "owner",
    })

    const acme = await organizationContext(store, refs.acme)

    expect(acme.people.items.map((one) => one.ref)).toEqual([refs.alice, refs.bob])
    expect(standings(acme.people.items[1])).toEqual(["contact:reported", "manager:confirmed"])
    expect(acme.people.items[0]?.roles[0]).toMatchObject({
      position: "Procurement manager",
      account: "example-crm:northstar.example",
    })
    expect(acme.deals.items.map((one) => one.ref)).toEqual([refs.deal])
    expect(acme.categories).toEqual(["client"])
    expect(acme.suppliers.items.map((one) => one.ref)).toEqual([refs.own])
    expect(acme.projects.items).toEqual([{ ref: refs.project, name: "Atlas", via: ["organization", "deal"] }])
    expect(acme.tasks.items.map((one) => one.ref)).toEqual([refs.task])
    expect(acme.communications).toEqual({ messages: 1, mail: 1, meetings: 1, hasMore: false })
    valid("organization_context", acme)
  })

  it("shows the invoice unpaid and no payment, as the finance store holds them", async () => {
    const { store, refs } = await scenario()

    const { money } = await organizationContext(store, refs.acme)

    expect(money.invoices.items).toEqual([
      expect.objectContaining({ ref: refs.invoice, status: "issued", open: "1200.00", linkedBy: ["counterparty"] }),
    ])
    expect(money.payments.items).toEqual([])
    expect(money.totals).toEqual({
      invoices: [{ status: "issued", currency: "EUR", rows: 1, total: "1200.00", open: "1200.00" }],
      payments: [],
    })
  })

  it("marks a contact the CRM stopped reporting as ended, after the current ones", async () => {
    const { store, crm, sync, refs } = await scenario()
    crm.put("person", { externalId: "7", name: "Alice", email: "alice@acme.example", organizations: [] })
    await sync()

    const acme = await organizationContext(store, refs.acme)

    expect(acme.people.items.map((one) => one.ref)).toEqual([refs.bob, refs.alice])
    expect(standings(acme.people.items[1])).toEqual(["contact:ended"])
    expect(acme.communications.messages).toBe(0)
  })

  it("counts only in the accounts asked for, and names the ones left out", async () => {
    const { store, refs } = await scenario()

    const acme = await organizationContext(store, refs.acme, { accounts: [ACME_TELEGRAM] })

    expect(acme.communications).toMatchObject({ messages: 1, mail: 0, meetings: 0 })
    expect(acme.coverage.accounts).toEqual(["telegram:100"])
    expect(acme.coverage.notRead.map((one) => one.source)).toEqual([
      "email:owner@northstar.example",
      "example-crm:northstar.example",
      "events",
    ])
  })

  it("derives client and employer from relationships, and no supplier the owner's company buys from", async () => {
    const { store, refs } = await scenario()

    const refsOf = async (category: "client" | "supplier" | "employer") =>
      (await organizationsInCategory(store, category)).map((one) => one.ref)

    expect(await refsOf("client")).toEqual([refs.acme])
    expect(await refsOf("supplier")).toEqual([])
    expect(await refsOf("employer")).toEqual([refs.own])
  })

  it("takes the owner's word that an organization is not his own over the CRM's flag", async () => {
    const { store, sync, refs } = await scenario()
    await store.knowledge.setOwnOrganization(refs.own, false)
    await sync()

    expect((await organizationContext(store, refs.acme)).categories).toEqual([])
    expect((await organizationContext(store, refs.own)).organization.own).toBe(false)
  })
})

describe("deal context", () => {
  it("has Alice as contact, Bob as decision-maker and Emma as owner, each with its standing", async () => {
    const { store, refs } = await scenario()

    const deal = await dealContext(store, refs.deal, { now: ACME_NOW })

    expect(deal.participants.items.map((one) => [one.ref, standings(one)])).toEqual([
      [refs.alice, ["contact:reported"]],
      [refs.emma, ["owner:reported"]],
      [refs.bob, ["decision-maker:confirmed"]],
    ])
    expect(deal.owner?.ref).toBe(refs.emma)
    expect(deal.organization).toEqual({ ref: refs.acme, name: "Acme Ltd", categories: ["client"] })
    valid("deal_context", deal)
  })

  it("shows the meeting, the mail and the message within its lifetime as proposed, the meeting once", async () => {
    const { store, refs } = await scenario()

    const { communications, window } = await dealContext(store, refs.deal, { now: ACME_NOW })

    expect(window).toEqual({ since: "2026-10-01T00:00:00.000Z", until: "2026-11-01T00:00:00.000Z" })
    expect(communications.counts).toEqual({ messages: 1, mail: 1, meetings: 1 })
    expect(communications.items.map((one) => [one.kind, one.standing])).toEqual([
      ["meeting", "proposed"],
      ["mail", "proposed"],
      ["message", "proposed"],
    ])
    expect(communications.items[0]?.people.toSorted()).toEqual([refs.alice, refs.bob, refs.emma].toSorted())
  })

  it("keeps the invoice issued and unpaid whatever the stage, and lists no payment", async () => {
    const { store, crm, sync, refs } = await scenario()
    crm.put("deal", {
      externalId: "d1",
      title: "Acme renewal",
      pipeline: "deal-1",
      stage: "won",
      organization: "c1",
      people: [{ externalId: "7", role: "contact", primary: true }],
      assignee: "u1",
      createdAt: Date.UTC(2026, 9, 1),
    })
    await sync()

    const deal = await dealContext(store, refs.deal, { now: ACME_NOW })

    expect(deal.deal.status).toBe("won")
    expect(deal.stages.items.map((one) => `${one.from} → ${one.to}`)).toEqual(["null → New", "New → Won"])
    expect(deal.money.invoices.items).toEqual([expect.objectContaining({ status: "issued", open: "1200.00" })])
    expect(deal.money.payments.items).toEqual([])
  })

  it("keeps the owner's project on the CRM copy through the next sync, and reaches money by project too", async () => {
    const { store, sync, refs } = await scenario()
    await sync()

    const deal = await dealContext(store, refs.deal, { now: ACME_NOW })

    expect(deal.project).toEqual({ ref: refs.project, name: "Atlas" })
    expect(deal.money.invoices.items).toEqual([
      expect.objectContaining({ ref: refs.invoice, linkedBy: ["project", "counterparty"] }),
    ])
    expect(deal.tasks.items.map((one) => one.ref)).toEqual([refs.task])
  })

  it("gives a brief with names, roles and counts", async () => {
    const { store, refs } = await scenario()

    const brief = dealBrief(await dealContext(store, refs.deal, { now: ACME_NOW }))

    expect(brief).toMatchObject({
      title: "Acme renewal",
      organization: "Acme Ltd",
      owner: "Emma",
      communications: { messages: 1, mail: 1, meetings: 1, standing: "proposed" },
    })
    expect(brief.people.map((one) => `${one.name}:${one.roles.join("+")}:${one.standing}`)).toEqual([
      "Alice:contact:reported",
      "Emma:owner:reported",
      "Bob:decision-maker:confirmed",
    ])
    valid("deal_context.brief", brief)
  })
})

describe("canonical person context", () => {
  it("answers for Alice across her CRM contact, mail address and Telegram, with her business", async () => {
    const { store, refs } = await scenario()

    const alice = await canonicalPersonContext(store, refs.alice)

    expect(alice.person.name).toBe("Alice")
    expect(alice.recent.direct.map((one) => one.text)).toEqual(["Can we renew Atlas before December?"])
    expect(alice.business.organizations.items).toEqual([
      expect.objectContaining({ ref: refs.acme, categories: ["client"] }),
    ])
    expect(alice.business.deals.items.map((one) => [one.ref, standings(one)])).toEqual([
      [refs.deal, ["contact:reported"]],
    ])
    valid("person_context", alice)
  })

  it("answers for a CRM-only person, naming the sources it has nothing to read by", async () => {
    const { store, refs } = await scenario()

    const emma = await canonicalPersonContext(store, refs.emma)

    expect(emma.person.name).toBe("Emma")
    expect(emma.business.organizations.items).toEqual([
      expect.objectContaining({
        ref: refs.own,
        categories: ["employer"],
        roles: [expect.objectContaining({ role: "employee", standing: "reported", position: "Sales owner" })],
      }),
    ])
    expect(emma.business.deals.items.map((one) => [one.ref, standings(one)])).toEqual([[refs.deal, ["owner:reported"]]])
    expect(emma.coverage.notRead.map((one) => one.source)).toEqual(["messages", "example-crm:northstar.example"])
    expect(emma.coverage.notRead[1]?.reason).toMatch(/did not list departments: .*report/)
    expect(emma.events.recent.map((one) => one.ref)).toEqual([expect.stringMatching(/^event:/)])
  })

  it("answers for a person known by name only", async () => {
    const { store } = await scenario()
    const dana = await store.people.add({ name: "Dana" })

    const found = await canonicalPersonContext(store, `person:${dana.uid}`)

    expect(found.person).toMatchObject({ name: "Dana", identities: [] })
    expect(found.business.organizations.items).toEqual([])
    expect(found.coverage.notRead.map((one) => one.source)).toEqual([
      "messages",
      "mail",
      "example-crm:northstar.example",
    ])
    valid("person_context", found)
  })

  it("reads both accounts that saw them and never asks for one, and keeps to the accounts given", async () => {
    const { store, refs } = await scenario()
    const second = { provider: "telegram", account: "300" }
    await store.accounts.saveAccount(second, { name: null })
    await store.chats.saveChats(second, [
      { id: "201", title: "Alice", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.people.savePeople(second, [{ id: "201", name: "Alice" }])

    const both = await canonicalPersonContext(store, refs.alice)
    const one = await canonicalPersonContext(store, refs.alice, { accounts: [ACME_TELEGRAM] })

    expect(both.coverage.accounts).toEqual(expect.arrayContaining(["telegram:100", "telegram:300"]))
    expect(both.shared.map((chat) => chat.account).toSorted()).toEqual(["100", "300"])
    expect(one.shared.map((chat) => chat.account)).toEqual(["100"])
    expect(one.coverage.notRead).toContainEqual({ source: "telegram:300", reason: "outside the accounts asked for" })
    expect(one.events).toEqual({ upcoming: [], recent: [] })
  })
})
