import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { snakeKeys } from "../cli/envelope.js"
import { ACME_NOW, ACME_OPENED, ACME_TELEGRAM, acmeScenario } from "../crm/testing/index.js"
import { ENTITIES } from "../entities/index.js"
import { type MessageStore, openStore } from "../store/store.js"
import { newestFirst, organizationsInCategory } from "./business-context.js"
import { dealBrief, dealContext } from "./deal-context.js"
import { organizationContext } from "./organization-context.js"
import { canonicalPersonContext } from "./person-business.js"

const DAY = 86_400_000
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

  it("shows no CRM deal, person role or count outside the accounts asked for, and says the CRM was not read", async () => {
    const { store, refs } = await scenario()

    const acme = await organizationContext(store, refs.acme, { accounts: [ACME_TELEGRAM] })

    expect(acme.people.items).toEqual([])
    expect(acme.deals.items).toEqual([])
    expect(acme.communications).toMatchObject({ messages: 0, mail: 0, meetings: 0 })
    expect(acme.money.invoices.items.map((one) => one.ref)).toEqual([refs.invoice])
    expect(acme.coverage.notRead).toContainEqual({
      source: "example-crm:northstar.example",
      reason: "outside the accounts asked for",
    })
    await expect(dealContext(store, refs.deal, { accounts: [ACME_TELEGRAM] })).rejects.toMatchObject({
      code: "not_found",
      details: { reason: "deal.out-of-scope" },
    })
    const alice = await canonicalPersonContext(store, refs.alice, { accounts: [ACME_TELEGRAM] })
    expect([alice.business.organizations.items, alice.business.deals.items]).toEqual([[], []])
  })

  it("lists a relationship an agent proposed, as proposed, after the current ones", async () => {
    const { store, refs } = await scenario()
    const proposal = await store.knowledge.relate(null, {
      from: refs.emma,
      to: refs.acme,
      kind: "member-of",
      role: "adviser",
      by: { bot: "claude-code" },
    })

    const acme = await organizationContext(store, refs.acme)

    expect(acme.people.items.map((one) => [one.ref, standings(one)])).toEqual([
      [refs.alice, ["contact:reported"]],
      [refs.bob, ["contact:reported"]],
      [refs.emma, ["adviser:proposed"]],
    ])
    expect(acme.people.items[2]?.roles[0]).toEqual({
      proposal: proposal.id,
      kind: "member-of",
      role: "adviser",
      standing: "proposed",
    })
  })

  it("says the money may be incomplete when a read stops at the store's page", async () => {
    const { store, refs } = await scenario()
    for (let at = 0; at < 500; at++)
      await store.finance.addInvoice({
        by: "owner",
        direction: "receivable",
        counterparty: refs.acme,
        currency: "EUR",
        lines: [{ description: `Line ${at}`, amount: "1.00" }],
      })

    const { money } = await organizationContext(store, refs.acme)

    expect(money.complete).toBe(false)
    expect(money.invoices).toMatchObject({
      total: 500,
      hasMore: true,
      next: `invoices list counterparty:"${refs.acme}"`,
    })
  }, 30_000)

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

it("sorts newest first and an undated item last, in a fixed order", () => {
  const items = [
    { ref: "b", at: null },
    { ref: "c", at: "2026-10-02T00:00:00.000Z" },
    { ref: "a", at: null },
    { ref: "d", at: "2026-10-03T00:00:00.000Z" },
  ]
  expect(items.sort(newestFirst).map((one) => one.ref)).toEqual(["d", "c", "a", "b"])
})

describe("categories", () => {
  it("makes an organization both client and supplier, once each, across two own companies", async () => {
    const { store, refs } = await scenario()
    const second = (await store.knowledge.addOrganization({ kind: "company", name: "Northstar Labs" })).ref
    await store.knowledge.setOwnOrganization(second, true)
    await store.knowledge.relate(null, { from: refs.acme, to: second, kind: "customer-of", by: "owner" })
    await store.knowledge.relate(null, { from: refs.own, to: refs.acme, kind: "customer-of", by: "owner" })

    expect((await organizationContext(store, refs.acme)).categories).toEqual(["client", "supplier"])
    expect((await organizationsInCategory(store, "client")).map((one) => one.ref)).toEqual([refs.acme])
    expect((await canonicalPersonContext(store, refs.alice)).business.categories).toEqual(["client", "supplier"])
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

  it("never reads the owner's own chats through him as a participant", async () => {
    const { store, refs } = await scenario()
    const at = new Date(ACME_OPENED + 9 * DAY).toISOString()
    await store.chats.saveChats(ACME_TELEGRAM, [
      { id: "999", title: "Zed", kind: "dialog", unreadCount: 0, lastMessageAt: at, participantsCount: null },
    ])
    await store.people.savePeople(ACME_TELEGRAM, [{ id: "999", name: "Zed" }])
    await store.messages.saveMessages(
      ACME_TELEGRAM,
      "999",
      [
        {
          id: "5",
          chatId: "999",
          senderId: "999",
          senderName: "Zed",
          timestamp: at,
          editedAt: null,
          text: "private",
          outgoing: false,
          attachments: [],
          replyTo: null,
          forwardedFrom: null,
          reactions: null,
        },
      ],
      { via: "test" },
    )
    await store.roster.saveMembers(ACME_TELEGRAM, "999", ["999", "100"])
    await store.people.savePeople(ACME_TELEGRAM, [{ id: "100", name: "Me" }])
    const owner = await store.people.linkToOwner({ provider: "telegram", id: "100" })
    await store.knowledge.relate(null, {
      from: refs.deal,
      to: refs.owner,
      kind: "related-to",
      role: "owner",
      by: "owner",
    })

    const deal = await dealContext(store, refs.deal, { now: ACME_NOW })
    const own = await organizationContext(store, refs.own)

    expect(owner?.uid).toBe(refs.owner.slice("person:".length))
    expect(deal.communications.items.map((one) => one.title)).not.toContain("Zed")
    expect(deal.communications.counts).toEqual({ messages: 1, mail: 1, meetings: 1 })
    expect(own.communications.messages).toBe(0)
  })

  it("counts every stage and touch in total, lists the newest, and names no command it cannot give", async () => {
    const { store, crm, sync, refs } = await scenario()
    for (const stage of ["quote", "new", "quote"]) {
      crm.put("deal", {
        externalId: "d1",
        title: "Acme renewal",
        pipeline: "deal-1",
        stage,
        organization: "c1",
        people: [{ externalId: "7", role: "contact", primary: true }],
        assignee: "u1",
        createdAt: ACME_OPENED,
      })
      await sync()
    }

    const small = await dealContext(store, refs.deal, { now: ACME_NOW, limit: 1 })

    expect(small.stages).toMatchObject({ total: 4, hasMore: true, next: null })
    expect(small.stages.items.map((one) => one.to)).toEqual(["Quote sent"])
    expect(small.communications).toMatchObject({ total: 3, hasMore: true, next: null })
    expect(small.money.invoices).toMatchObject({ total: 1, hasMore: false, next: null })
    expect(small.deal.project).toBe(refs.project)

    await store.deals.setProject(refs.deal, { project: null, by: "owner" })
    const bare = await dealContext(store, refs.deal, { now: ACME_NOW, limit: 0 })
    expect(bare.money.invoices.next).toBe(`invoices list counterparty:"${refs.acme}"`)
    expect(bare.tasks).toMatchObject({ total: 0, next: null })
    const both = await dealContext(
      store,
      (await store.deals.setProject(refs.deal, { project: refs.project, by: "owner" })).ref,
      {
        now: ACME_NOW,
        limit: 0,
      },
    )
    expect(both.money.invoices.next).toBeNull()
    expect(both.tasks.next).toBe("tasks list project:ATLA")
  })

  it("gives a brief with names, roles and counts", async () => {
    const { store, refs } = await scenario()

    await store.finance.addInvoice({
      by: { bot: "claude-code" },
      direction: "receivable",
      counterparty: refs.acme,
      currency: "EUR",
      lines: [{ description: "Extra seats", amount: "90.00" }],
    })

    const brief = dealBrief(await dealContext(store, refs.deal, { now: ACME_NOW }))
    const listsNone = dealBrief(await dealContext(store, refs.deal, { now: ACME_NOW, limit: 0 }))

    expect(brief).toMatchObject({
      title: "Acme renewal",
      organization: "Acme Ltd",
      owner: "Emma",
      communications: { messages: 1, mail: 1, meetings: 1, standing: "proposed" },
      money: { unconfirmed: 1, complete: true },
    })
    expect(brief.people.map((one) => `${one.name}:${one.roles.join("+")}:${one.standing}`)).toEqual([
      "Alice:contact:reported",
      "Emma:owner:reported",
      "Bob:decision-maker:confirmed",
    ])
    expect(listsNone.money.unconfirmed).toBe(1)
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
