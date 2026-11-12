import { CliError } from "@wirecat/cli-base"
import { parseLucene } from "@wirecat/cli-base/query"
import { DEAL_KINDS, type DealKind } from "../domain/deals.js"
import { isUsable } from "../domain/relations.js"
import type { AccountKey, Deal, FinancePayment, Invoice, MessageStore, Organization } from "../store/index.js"
import { isClosedState } from "../tasks/index.js"
import {
  type Category,
  type Coverage,
  coverageFor,
  edgesOf,
  grouped,
  namesOf,
  notRejected,
  organizationCategories,
  type Related,
  SECTION_LIMIT,
  type Section,
  STORE_PAGE,
  scopeOf,
  sectionOf,
} from "./business-context.js"
import { type Communications, communicationsOf } from "./communications.js"
import { type LinkedBy, type MoneySection, moneyOf, type OrderLine } from "./money-context.js"

export interface DealLine {
  ref: string
  kind: Deal["kind"]
  title: string
  summary: string
  stage: string
  status: Deal["status"]
  currency: string | null
  amount: string | null
  closeDate: string | null
  project: string | null
}

export interface ProjectLine {
  ref: string
  name: string
  /** It names the organization, or one of its deals does. */
  via: ("organization" | "deal")[]
}

export interface TaskLine {
  ref: string
  key: string
  title: string
  status: string
  project: string
  dueAt: string | null
}

export interface OrganizationContext {
  organization: Organization & { own: boolean }
  categories: Category[]
  /** Its members, each once with every role and the standing of each; the current ones first. */
  people: Section<Related>
  /** Who is its customer. */
  customers: Section<Related>
  /** Whom it is a customer of: "supplier of", read backwards. */
  suppliers: Section<Related>
  partners: Section<Related>
  projects: Section<ProjectLine>
  /** Open deals and leads it is the client of. */
  deals: Section<DealLine>
  money: MoneySection
  /** Counts only, through its own people other than the owner, in the accounts read. */
  communications: Communications["counts"] & { hasMore: boolean }
  /** Open tasks of its projects. */
  tasks: Section<TaskLine>
  coverage: Coverage
}

export interface OrganizationContextOptions {
  /** The accounts read: a CRM's relationships and deals, and its people's messages, mail and events. */
  accounts?: AccountKey[]
  /** Items per section. */
  limit?: number
  /** The kinds the profile denies: none of their rows, titles or counts is answered. */
  deniedKinds?: readonly DealKind[]
}

export const dealLine = (deal: Deal): DealLine => ({
  ref: deal.ref,
  kind: deal.kind,
  title: deal.title,
  summary: deal.summary,
  stage: deal.stage,
  status: deal.status,
  currency: deal.currency,
  amount: deal.amount,
  closeDate: deal.closeDate,
  project: deal.project,
})

/** Open tasks of these projects, the soonest due first, and the command that lists them when it is one project's. */
export const openTasksOf = async (
  store: MessageStore,
  projects: { ref: string; key: string }[],
): Promise<{ tasks: TaskLine[]; full: boolean; next: string | null }> => {
  const tasks: TaskLine[] = []
  let full = false
  for (const project of projects) {
    const { items: found, hasMore } = await store.tasks.find({ project: project.ref, limit: STORE_PAGE })
    full ||= hasMore
    for (const task of found)
      if (!isClosedState(task.status))
        tasks.push({
          ref: task.ref,
          key: task.key,
          title: task.title,
          status: task.status,
          project: task.project,
          dueAt: task.dueAt,
        })
  }
  const [only] = projects
  return {
    tasks: tasks.sort((a, b) => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~") || a.ref.localeCompare(b.ref)),
    full,
    next: projects.length === 1 && only ? `tasks list project:${only.key}` : null,
  }
}

/** The one list command that holds every row, when the rows are all of one kind. */
const oneKind = <T>(rows: T[], commands: [(row: T) => boolean, string][]): string | null =>
  commands.find(([fits]) => rows.every(fits))?.[1] ?? null

/**
 * One answer about an organization from the store: its people, its customers, suppliers and partners, projects,
 * open deals, money and how much the owner talks with its people. Every relationship says its standing; a source
 * nobody confirmed is `reported`, one that stopped is `ended`, one waiting for the owner `proposed`. A CRM's rows
 * outside `accounts` are left out, and `coverage` names that CRM.
 */
export const organizationContext = async (
  store: MessageStore,
  reference: string,
  { accounts, limit = SECTION_LIMIT, deniedKinds = [] }: OrganizationContextOptions = {},
): Promise<OrganizationContext> => {
  const id = /^(?:organization:)?(\d+)$/.exec(reference.trim())?.[1]
  if (id === undefined) throw new CliError("validation_error", "an organization is organization:<id>")
  const ref = `organization:${id}`
  const [organization] = await store.knowledge.organizations(parseLucene(`id:${id}`))
  if (!organization) throw new CliError("not_found", `no ${ref} in the store`)
  const scope = scopeOf(accounts, deniedKinds)
  const own = (await store.knowledge.ownOrganizations()).some((one) => one.ref === ref)
  const { edges, full } = await edgesOf(store, ref, scope)
  const names = await namesOf(
    store,
    edges.flatMap(({ from, to }) => [from, to]),
  )
  const into = (kind: string, from: string) => (edge: (typeof edges)[number]) =>
    edge.role.kind === kind && edge.to === ref && edge.from.startsWith(from) ? edge.from : undefined
  const people = grouped(edges, into("member-of", "person:"), names)
  const customers = grouped(edges, into("customer-of", ""), names)
  const suppliers = grouped(
    edges,
    (edge) => (edge.role.kind === "customer-of" && edge.from === ref ? edge.to : undefined),
    names,
  )
  const partners = grouped(
    edges,
    (edge) => (edge.role.kind !== "partner-of" ? undefined : edge.from === ref ? edge.to : edge.from),
    names,
  )

  const deals: Deal[] = []
  let dealsFull = false
  for (const kind of DEAL_KINDS.filter((one) => !scope.denied.has(one))) {
    const found = await store.deals.list({
      kind,
      organization: ref,
      status: "open",
      limit: STORE_PAGE,
      ...(accounts === undefined ? {} : { accounts }),
    })
    dealsFull ||= found.hasMore
    for (const deal of found.items) deals.push(deal)
  }
  const catalog = new Map((await store.knowledge.projects()).map((project) => [project.ref, project]))
  const projects = new Map<string, ProjectLine>()
  for (const project of catalog.values())
    if (project.organizationId === organization.id)
      projects.set(project.ref, { ref: project.ref, name: project.name, via: ["organization"] })
  for (const deal of deals)
    if (deal.project !== null) {
      const held = projects.get(deal.project) ?? { ref: deal.project, name: deal.projectName ?? deal.project, via: [] }
      if (!held.via.includes("deal")) held.via.push("deal")
      projects.set(deal.project, held)
    }

  const invoiceRows = await store.finance.invoices({ counterparty: ref, limit: STORE_PAGE })
  const paymentRows = await store.finance.payments({ party: ref, limit: STORE_PAGE })
  const invoices: [Invoice, LinkedBy][] = notRejected(invoiceRows.items).map((invoice) => [invoice, "counterparty"])
  const payments: [FinancePayment, LinkedBy][] = notRejected(paymentRows.items).map((payment) => [
    payment,
    "counterparty",
  ])
  const orders: OrderLine[] = []
  let ordersFull = false
  for (const side of ["customer", "supplier"] as const) {
    const found = await store.orders.list({ [side]: ref, limit: STORE_PAGE })
    ordersFull ||= found.hasMore
    for (const order of notRejected(found.items))
      orders.push({
        ref: order.ref,
        title: order.title,
        status: order.status,
        review: order.review,
        currency: order.currency,
        total: order.total,
        side,
      })
  }
  const financeComplete = !invoiceRows.hasMore && !paymentRows.hasMore && !ordersFull

  const members = []
  for (const person of people)
    if (person.roles.some((role) => isUsable(role.standing))) {
      const record = await store.people.personByUid(person.ref.slice("person:".length))
      if (record) members.push(record)
    }
  const talks = await communicationsOf(store, members, scope)
  const categories = (await organizationCategories(store, scope)).get(ref) ?? []
  const tasks = await openTasksOf(
    store,
    [...projects.keys()].flatMap((one) => {
      const project = catalog.get(one)
      return project ? [{ ref: one, key: project.key }] : []
    }),
  )
  const about = `about:${ref}`
  const more = { more: full }
  return {
    organization: { ...organization, own },
    categories,
    people: sectionOf(people, limit, `relationships list ${about} kind:member-of`, more),
    customers: sectionOf(customers, limit, `relationships list to:${ref} kind:customer-of`, more),
    suppliers: sectionOf(suppliers, limit, `relationships list from:${ref} kind:customer-of`, more),
    partners: sectionOf(partners, limit, `relationships list ${about} kind:partner-of`, more),
    projects: sectionOf([...projects.values()], limit, null),
    deals: sectionOf(
      deals.map(dealLine),
      limit,
      oneKind(deals, [
        [(deal) => deal.kind === "deal", `deals list organization:"${ref}" status:open`],
        [(deal) => deal.kind === "lead", `leads list organization:"${ref}" status:open`],
      ]),
      { more: dealsFull },
    ),
    money: moneyOf(
      { invoices, payments, orders },
      limit,
      {
        invoices: `invoices list counterparty:"${ref}"`,
        payments: `payments list party:"${ref}"`,
        orders: oneKind(orders, [[(order) => order.side === "customer", `orders list customer:"${ref}"`]]),
      },
      financeComplete,
    ),
    communications: { ...talks.counts, hasMore: talks.hasMore },
    tasks: sectionOf(tasks.tasks, limit, tasks.next, { more: tasks.full }),
    coverage: await coverageFor(store, talks.coverage, scope),
  }
}
