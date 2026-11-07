import type { CrmUser } from "../../domain/crm.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import { type CrmSyncReport, syncCrm } from "../index.js"
import { type FakeCrmSource, fakeCrmSource } from "./source.js"

/** The CRM portal of the owner's own company, Northstar Consulting. */
export const ACME_PORTAL: AccountKey = { provider: "example-crm", account: "northstar.example" }
export const ACME_TELEGRAM: AccountKey = { provider: "telegram", account: "100" }
export const ACME_MAIL: AccountKey = { provider: "email", account: "owner@northstar.example" }
export const ACME_CALENDAR: AccountKey = { provider: "google-calendar", account: "owner@northstar.example" }

const DAY = 86_400_000
/** The deal opens on this day; every message, mail and meeting falls within its first month. */
export const ACME_OPENED = Date.UTC(2026, 9, 1)
export const ACME_NOW = Date.UTC(2026, 10, 1)

const USERS: CrmUser[] = [
  { externalId: "u1", name: "Emma", email: "emma@northstar.example", position: "Sales owner", departments: ["10"] },
]

export interface AcmeScenario {
  store: MessageStore
  /** The portal: change a row with `crm.put` or `crm.delete`, then `sync()` again. */
  crm: FakeCrmSource
  sync: () => Promise<CrmSyncReport>
  refs: {
    owner: string
    /** Northstar Consulting, the owner's own company. */
    own: string
    acme: string
    alice: string
    bob: string
    emma: string
    deal: string
    project: string
    invoice: string
    task: string
    event: string
  }
}

/**
 * Plan §8's scenario, synthetic: Northstar Consulting is the owner's own company and its CRM portal, Acme Ltd its
 * customer. Alice and Bob are Acme's CRM contacts; Emma is a portal user, Northstar's sales owner and the deal's owner.
 * The deal "Acme renewal" has Alice as contact (CRM), Bob as decision-maker (the owner's) and project Atlas (the
 * owner's, on the CRM copy). The owner has a Telegram dialog with Alice, a mail with Bob, a Zoom meeting with all three, an invoice to
 * Acme with no payment and an open follow-up task. Everything is written through the store's and the CRM sync's own
 * calls; the store is the caller's, and no real account is touched.
 */
export const acmeScenario = async (store: MessageStore): Promise<AcmeScenario> => {
  const crm = fakeCrmSource({ traits: { removedInChanges: true } })
  crm.put("organization", { externalId: "c1", name: "Acme Ltd" })
  crm.put("organization", { externalId: "my1", name: "Northstar Consulting", own: true })
  crm.put("person", {
    externalId: "7",
    name: "Alice",
    email: "alice@acme.example",
    position: "Procurement manager",
    organizations: [{ externalId: "c1", primary: true }],
  })
  crm.put("person", { externalId: "8", name: "Bob", email: "bob@acme.example", organizations: [{ externalId: "c1" }] })
  crm.put("deal", {
    externalId: "d1",
    title: "Acme renewal",
    pipeline: "deal-1",
    stage: "new",
    organization: "c1",
    people: [{ externalId: "7", role: "contact", primary: true }],
    assignee: "u1",
    createdAt: ACME_OPENED,
  })
  const source = Object.assign(crm, { users: async () => USERS })
  const sync = () => syncCrm(source, store, ACME_PORTAL, { rescan: true, now: ACME_NOW })
  await sync()

  const personOf = async (email: string) =>
    `person:${(await store.people.personOf({ provider: "email", id: email }))?.uid}`
  const [alice, bob, emma] = await Promise.all(
    ["alice@acme.example", "bob@acme.example", "emma@northstar.example"].map(personOf),
  )
  const organizations = await store.knowledge.organizations()
  const named = (name: string) => organizations.find((one) => one.name === name)?.ref as string
  const acme = named("Acme Ltd")
  const own = named("Northstar Consulting")
  const deal = (await store.crm.refOf(ACME_PORTAL, "deal", "d1")) as string
  const owner = `person:${(await store.people.owner())?.uid}`

  const relate = (from: string, to: string, kind: "member-of" | "customer-of" | "related-to", role?: string) =>
    store.knowledge.relate(null, { from, to, kind, ...(role ? { role } : {}), by: "owner" })
  await relate(acme, own, "customer-of")
  await relate(owner, own, "member-of", "founder")
  await relate(deal, bob as string, "related-to", "decision-maker")

  const project = (await store.knowledge.addProject({ name: "Atlas", organization: acme })).ref
  await store.deals.setProject(deal, { project, by: "owner" })
  const invoice = (
    await store.finance.addInvoice({
      by: "owner",
      direction: "receivable",
      counterparty: acme,
      currency: "EUR",
      issueDate: "2026-10-10",
      project,
      lines: [{ description: "Atlas renewal", amount: "1200.00" }],
    })
  ).ref
  const task = (await store.tasks.create({ project, title: "Follow up on the Acme renewal", type: "chore" }, "owner"))
    .ref

  await store.accounts.saveAccount(ACME_TELEGRAM, { name: null })
  await store.chats.saveChats(ACME_TELEGRAM, [
    {
      id: "201",
      title: "Alice",
      kind: "dialog",
      unreadCount: 0,
      lastMessageAt: new Date(ACME_OPENED + 3 * DAY).toISOString(),
      participantsCount: null,
    },
  ])
  await store.people.savePeople(ACME_TELEGRAM, [{ id: "201", name: "Alice" }])
  await store.messages.saveMessages(
    ACME_TELEGRAM,
    "201",
    [
      {
        id: "1",
        chatId: "201",
        senderId: "201",
        senderName: "Alice",
        timestamp: new Date(ACME_OPENED + 3 * DAY).toISOString(),
        editedAt: null,
        text: "Can we renew Atlas before December?",
        outgoing: false,
        attachments: [],
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
      },
    ],
    { via: "acme-scenario" },
  )
  await store.roster.saveMembers(ACME_TELEGRAM, "201", ["201", "100"])
  await store.people.linkIdentities(
    { provider: "email", id: "alice@acme.example" },
    { provider: "telegram", id: "201" },
    { method: "manual", by: "owner" },
  )

  const mail = await store.accounts.saveAccount(ACME_MAIL, { name: null })
  await store.mail.saveThread({
    accountId: mail,
    externalId: "renewal-terms",
    now: ACME_NOW,
    emails: [
      {
        externalId: "<terms@acme.example>",
        subject: "Renewal terms",
        from: { address: "bob@acme.example", name: "Bob" },
        to: [{ address: ACME_MAIL.account, name: null }],
        sentAt: ACME_OPENED + 5 * DAY,
        receivedAt: ACME_OPENED + 5 * DAY,
        bodyText: "Here are our terms for the renewal.",
        outgoing: false,
      },
    ],
  })
  await store.people.savePeople(ACME_MAIL, [{ id: "bob@acme.example", name: "Bob" }])

  const calendarAccount = await store.accounts.saveAccount(ACME_CALENDAR, { name: null })
  const [calendar] = await store.calendar.saveCalendars(
    calendarAccount,
    [
      {
        externalId: "primary",
        title: "Work",
        timezone: "UTC",
        accessRole: "owner",
        primary: true,
        syncByDefault: true,
      },
    ],
    ACME_NOW,
  )
  await store.calendar.saveEntries(
    calendar?.id as number,
    [
      {
        externalId: "renewal-call",
        kind: "single",
        status: "confirmed",
        title: "Acme renewal call (Zoom)",
        location: "https://zoom.example/j/1",
        startsAt: ACME_OPENED + 7 * DAY,
        endsAt: ACME_OPENED + 7 * DAY + 3_600_000,
        participants: [
          { email: "alice@acme.example", name: "Alice" },
          { email: "bob@acme.example", name: "Bob" },
          { email: "emma@northstar.example", name: "Emma" },
        ],
      },
    ],
    ACME_NOW,
  )
  const [event] = await store.calendar.events({ limit: 1 })

  return {
    store,
    crm,
    sync,
    refs: {
      owner,
      own,
      acme,
      alice: alice as string,
      bob: bob as string,
      emma: emma as string,
      deal,
      project,
      invoice,
      task,
      event: `event:${event?.id}`,
    },
  }
}
