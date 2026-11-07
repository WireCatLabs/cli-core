import { CliError } from "@wirecat/cli-base"
import { parseLucene } from "@wirecat/cli-base/query"
import { DEAL_KINDS } from "../domain/deals.js"
import { isUsable } from "../domain/relations.js"
import type { AccountKey, Deal, FinancePayment, Invoice, MessageStore, Organization } from "../store/index.js"
import { isClosedState } from "../tasks/index.js"
import {
  type Category,
  type Coverage,
  grouped,
  namesOf,
  organizationCategories,
  type Related,
  relationsOf,
  SECTION_LIMIT,
  type Section,
  sectionOf,
} from "./business-context.js"
import { type Communications, communicationsOf } from "./communications.js"
import { type LinkedBy, type MoneySection, moneyOf, type OrderLine } from "./money-context.js"

/** Rows read from each finance list; the list answers at most this many. */
const FINANCE_ROWS = 500

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
  /** Counts only, through its own people, in the accounts read. */
  communications: Communications["counts"] & { hasMore: boolean }
  /** Open tasks of its projects. */
  tasks: Section<TaskLine>
  coverage: Coverage
}

export interface OrganizationContextOptions {
  /** The accounts its people's messages, mail and events are counted in; left out, every account. */
  accounts?: AccountKey[]
  /** Items per section. */
  limit?: number
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

/** Open tasks of these projects, the soonest due first. */
export const openTasksOf = async (store: MessageStore, projects: string[]): Promise<TaskLine[]> => {
  const tasks: TaskLine[] = []
  for (const project of projects)
    for (const task of await store.tasks.find({ project, limit: 500 }))
      if (!isClosedState(task.status))
        tasks.push({
          ref: task.ref,
          key: task.key,
          title: task.title,
          status: task.status,
          project: task.project,
          dueAt: task.dueAt,
        })
  return tasks.sort((a, b) => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~"))
}

const notRejected = <T extends { review: string }>(rows: T[]) => rows.filter((row) => row.review !== "rejected")

/**
 * One answer about an organization from the store: its people, its customers, suppliers and partners, projects,
 * open deals, money and how much the owner talks with its people. Every relationship says its standing; a source
 * nobody confirmed is `reported`, one that stopped is `ended`.
 */
export const organizationContext = async (
  store: MessageStore,
  reference: string,
  { accounts, limit = SECTION_LIMIT }: OrganizationContextOptions = {},
): Promise<OrganizationContext> => {
  const id = /^(?:organization:)?(\d+)$/.exec(reference.trim())?.[1]
  if (id === undefined) throw new CliError("validation_error", "an organization is organization:<id>")
  const ref = `organization:${id}`
  const [organization] = await store.knowledge.organizations(parseLucene(`id:${id}`))
  if (!organization) throw new CliError("not_found", `no ${ref} in the store`)
  const own = (await store.knowledge.ownOrganizations()).some((one) => one.ref === ref)
  const { relations, full } = await relationsOf(store, ref)
  const names = await namesOf(
    store,
    relations.flatMap(({ from, to }) => [from, to]),
  )
  const into = (kind: string, from: string) => (relation: (typeof relations)[number]) =>
    relation.kind === kind && relation.to === ref && relation.from.startsWith(from) ? relation.from : undefined
  const people = grouped(relations, into("member-of", "person:"), names)
  const customers = grouped(relations, into("customer-of", ""), names)
  const suppliers = grouped(
    relations,
    (relation) => (relation.kind === "customer-of" && relation.from === ref ? relation.to : undefined),
    names,
  )
  const partners = grouped(
    relations,
    (relation) => (relation.kind !== "partner-of" ? undefined : relation.from === ref ? relation.to : relation.from),
    names,
  )

  const deals: Deal[] = []
  for (const kind of DEAL_KINDS)
    for (const deal of await store.deals.list({ kind, organization: ref, limit: 500 })) deals.push(deal)
  const projects = new Map<string, { name: string; via: ProjectLine["via"] }>()
  for (const project of await store.knowledge.projects())
    if (project.organizationId === organization.id)
      projects.set(project.ref, { name: project.name, via: ["organization"] })
  for (const deal of deals)
    if (deal.project !== null) {
      const held = projects.get(deal.project) ?? { name: deal.projectName ?? deal.project, via: [] }
      if (!held.via.includes("deal")) held.via.push("deal")
      projects.set(deal.project, held)
    }

  const invoices: [Invoice, LinkedBy][] = notRejected(
    await store.finance.invoices({ counterparty: ref, limit: FINANCE_ROWS }),
  ).map((invoice) => [invoice, "counterparty"])
  const payments: [FinancePayment, LinkedBy][] = notRejected(
    await store.finance.payments({ party: ref, limit: FINANCE_ROWS }),
  ).map((payment) => [payment, "counterparty"])
  const orders: OrderLine[] = []
  for (const side of ["customer", "supplier"] as const)
    for (const order of notRejected(await store.orders.list({ [side]: ref, limit: FINANCE_ROWS })))
      orders.push({
        ref: order.ref,
        title: order.title,
        status: order.status,
        review: order.review,
        currency: order.currency,
        total: order.total,
        side,
      })

  const members = []
  for (const person of people)
    if (person.roles.some((role) => isUsable(role.standing))) {
      const record = await store.people.personByUid(person.ref.slice("person:".length))
      if (record) members.push(record)
    }
  const talks = await communicationsOf(store, members, accounts === undefined ? {} : { accounts })
  const categories = (await organizationCategories(store)).get(ref) ?? []
  const about = `about:${ref}`
  return {
    organization: { ...organization, own },
    categories,
    people: sectionOf(people, limit, `relationships list ${about} kind:member-of`, full),
    customers: sectionOf(customers, limit, `relationships list to:${ref} kind:customer-of`, full),
    suppliers: sectionOf(suppliers, limit, `relationships list from:${ref} kind:customer-of`, full),
    partners: sectionOf(partners, limit, `relationships list ${about} kind:partner-of`, full),
    projects: sectionOf(
      [...projects].map(([project, held]) => ({ ref: project, ...held })),
      limit,
      `projects list organization:${organization.id}`,
    ),
    deals: sectionOf(
      deals.filter((deal) => deal.status === "open").map(dealLine),
      limit,
      `deals list --organization ${ref} --status open`,
    ),
    money: moneyOf({ invoices, payments, orders }, limit, {
      invoices: `invoices list --counterparty ${ref}`,
      payments: `payments list --party ${ref}`,
      orders: `orders list --customer ${ref}`,
    }),
    communications: { ...talks.counts, hasMore: talks.hasMore },
    tasks: sectionOf(
      await openTasksOf(store, [...projects.keys()]),
      limit,
      `tasks list organization:${organization.id}`,
    ),
    coverage: talks.coverage,
  }
}
