import { CliError } from "@wirecat/cli-base"
import type { DealKind } from "../domain/deals.js"
import { isUsable, type Standing } from "../domain/relations.js"
import type { AccountKey, Deal, FinancePayment, Invoice, MessageStore, StageChange } from "../store/index.js"
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
import { type Communications, communicationsOf, type Touch } from "./communications.js"
import { type LinkedBy, type MoneySection, moneyOf } from "./money-context.js"
import { openTasksOf, type TaskLine } from "./organization-context.js"

const DAY = 86_400_000

/** Met or written to within the deal's lifetime by one of its people: an overlap of people, not a link. */
export type DealTouch = Touch & { standing: Extract<Standing, "proposed"> }

export interface DealContext {
  /** The row as stored: its status is the CRM's or the owner's, and a stage named won is not a payment. */
  deal: Deal
  /** The newest stages it entered, oldest of them first; `total` counts every one. */
  stages: Section<StageChange>
  organization: { ref: string; name: string | null; categories: Category[] } | null
  /** Its people, each once with every role and the standing of each. */
  participants: Section<Related>
  /** The participant whose usable role is `owner`, the CRM's "responsible". */
  owner: Related | null
  project: { ref: string; name: string | null } | null
  /** Its project's invoices and payments and its organization's, each saying how it was reached. */
  money: MoneySection
  /** From its creation to the day it closed, or now. */
  window: { since: string; until: string }
  communications: Section<DealTouch> & { counts: Communications["counts"] }
  tasks: Section<TaskLine>
  coverage: Coverage
}

export interface DealContextOptions {
  /** The accounts read: a CRM's copy and relationships, and its people's messages, mail and events. */
  accounts?: AccountKey[]
  limit?: number
  /** ms: the end of an open deal's window; the clock when absent. */
  now?: number
  /** The kinds the profile denies: a deal or lead of one is not answered. */
  deniedKinds?: readonly DealKind[]
}

/**
 * One answer about a deal or a lead from the store: the row, how it moved, its client, people, project, money and
 * what its people said within its lifetime. Nothing is inferred from a stage's name. A CRM's copy outside
 * `accounts` is not answered, and a CRM's relationships outside it are left out.
 */
export const dealContext = async (
  store: MessageStore,
  reference: string,
  { accounts, limit = SECTION_LIMIT, now = Date.now(), deniedKinds = [] }: DealContextOptions = {},
): Promise<DealContext> => {
  const scope = scopeOf(accounts, deniedKinds)
  const kind = /^lead:/.test(reference.trim()) ? "lead" : "deal"
  if (scope.denied.has(kind))
    throw new CliError("permission_error", `the profile denies ${kind}s.list, so no ${kind} is answered`, {
      reason: "deal.denied",
    })
  const row = await store.deals.get(reference)
  const deal = row.deal !== null && !scope.allows(row.deal) ? { ...row, deal: null } : row
  if (!scope.has(deal.account))
    throw new CliError("not_found", `${deal.ref} is a copy from an account outside the accounts asked for`, {
      reason: "deal.out-of-scope",
    })
  const { edges, full } = await edgesOf(store, deal.ref, scope)
  const people = edges.filter(
    (edge) => edge.role.kind === "related-to" && edge.from === deal.ref && edge.to.startsWith("person:"),
  )
  const names = await namesOf(
    store,
    people.map(({ to }) => to),
  )
  const participants = grouped(people, (edge) => edge.to, names)
  const owner =
    participants.find((one) => one.roles.some((role) => role.role === "owner" && isUsable(role.standing))) ?? null

  const organization = deal.organization
  const project =
    deal.project === null ? undefined : (await store.knowledge.projects()).find((one) => one.ref === deal.project)
  const invoices: [Invoice, LinkedBy][] = []
  const payments: [FinancePayment, LinkedBy][] = []
  let complete = true
  const ways = [
    ...(deal.project === null ? [] : [["project", { project: deal.project }, { project: deal.project }] as const]),
    ...(organization === null
      ? []
      : [["counterparty", { counterparty: organization.ref }, { party: organization.ref }] as const]),
  ]
  for (const [way, invoiceFilter, paymentFilter] of ways) {
    const invoiceRows = await store.finance.invoices({ ...invoiceFilter, limit: STORE_PAGE })
    const paymentRows = await store.finance.payments({ ...paymentFilter, limit: STORE_PAGE })
    complete &&= invoiceRows.length < STORE_PAGE && paymentRows.length < STORE_PAGE
    for (const invoice of notRejected(invoiceRows)) invoices.push([invoice, way])
    for (const payment of notRejected(paymentRows)) payments.push([payment, way])
  }
  const only = ways.length === 1 ? ways[0]?.[0] : undefined
  const moneyNext = {
    invoices:
      only === "project" && project
        ? `invoices list project:${project.key}`
        : only === "counterparty" && organization
          ? `invoices list counterparty:"${organization.ref}"`
          : null,
    payments:
      only === "project" && project
        ? `payments list project:${project.key}`
        : only === "counterparty" && organization
          ? `payments list party:"${organization.ref}"`
          : null,
  }

  const since = Date.parse(deal.createdAt)
  const until = deal.closedDate === null ? now : Date.parse(`${deal.closedDate}T00:00:00Z`) + DAY - 1
  const records = []
  for (const one of participants)
    if (one.roles.some((role) => isUsable(role.standing))) {
      const record = await store.people.personByUid(one.ref.slice("person:".length))
      if (record) records.push(record)
    }
  const talks = await communicationsOf(store, records, scope, { since, until, limit })
  const said = talks.counts.messages + talks.counts.mail + talks.counts.meetings
  const stages = await store.deals.stages(deal.ref)
  const tasks = await openTasksOf(store, project ? [{ ref: project.ref, key: project.key }] : [])
  return {
    deal,
    stages: sectionOf(stages, limit, null, { newest: true }),
    organization:
      organization === null
        ? null
        : {
            ref: organization.ref,
            name: organization.name,
            categories: (await organizationCategories(store, scope)).get(organization.ref) ?? [],
          },
    participants: sectionOf(participants, limit, `relationships list about:${deal.ref} kind:related-to`, {
      more: full,
    }),
    owner,
    project: deal.project === null ? null : { ref: deal.project, name: deal.projectName },
    money: moneyOf({ invoices, payments }, limit, moneyNext, complete),
    window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
    communications: {
      ...sectionOf(
        talks.items.map((touch) => ({ ...touch, standing: "proposed" as const })),
        limit,
        null,
        { more: talks.hasMore, total: Math.max(said, talks.items.length) },
      ),
      counts: talks.counts,
    },
    tasks: sectionOf(tasks.tasks, limit, tasks.next, { more: tasks.full }),
    coverage: await coverageFor(store, talks.coverage, scope),
  }
}

/** The compact form for a model's context: names, roles and standings, totals and counts, no row detail. */
export interface DealBrief {
  ref: string
  kind: Deal["kind"]
  title: string
  pipeline: string
  stage: string
  status: Deal["status"]
  amount: string | null
  currency: string | null
  closeDate: string | null
  organization: string | null
  owner: string | null
  people: { ref: string; name: string | null; roles: string[]; standing: Standing }[]
  project: string | null
  /** The newest stage changes, `from → to`. */
  stages: string[]
  money: MoneySection["totals"] & { unconfirmed: number; complete: boolean }
  communications: Communications["counts"] & { standing: "proposed" }
  openTasks: number
  notRead: Coverage["notRead"]
}

const BRIEF_STAGES = 5

/** The roles a brief names: the usable ones, or, when none holds now, every one with its standing. */
const briefRoles = (one: Related): { roles: string[]; standing: Standing } => {
  const usable = one.roles.filter((role) => isUsable(role.standing))
  const shown = usable.length > 0 ? usable : one.roles
  return {
    roles: shown.map((role) => role.role ?? role.kind),
    standing: shown.some((role) => role.standing === "confirmed") ? "confirmed" : (shown[0]?.standing ?? "proposed"),
  }
}

export const dealBrief = (context: DealContext): DealBrief => ({
  ref: context.deal.ref,
  kind: context.deal.kind,
  title: context.deal.title,
  pipeline: context.deal.pipelineName,
  stage: context.deal.stage,
  status: context.deal.status,
  amount: context.deal.amount,
  currency: context.deal.currency,
  closeDate: context.deal.closeDate,
  organization: context.organization?.name ?? context.organization?.ref ?? null,
  owner: context.owner?.name ?? context.owner?.ref ?? null,
  people: context.participants.items.map((one) => ({ ref: one.ref, name: one.name, ...briefRoles(one) })),
  project: context.project?.name ?? context.project?.ref ?? null,
  stages: context.stages.items.slice(-BRIEF_STAGES).map((change) => `${change.from ?? "∅"} → ${change.to}`),
  money: { ...context.money.totals, unconfirmed: context.money.unconfirmed, complete: context.money.complete },
  communications: { ...context.communications.counts, standing: "proposed" },
  openTasks: context.tasks.total,
  notRead: context.coverage.notRead,
})
