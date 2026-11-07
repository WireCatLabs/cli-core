import { isUsable, type Standing } from "../domain/relations.js"
import type { AccountKey, Deal, FinancePayment, Invoice, MessageStore, StageChange } from "../store/index.js"
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
  withCrmGaps,
} from "./business-context.js"
import { type Communications, communicationsOf, type Touch } from "./communications.js"
import { type LinkedBy, type MoneySection, moneyOf } from "./money-context.js"
import { openTasksOf, type TaskLine } from "./organization-context.js"

const FINANCE_ROWS = 500
const DAY = 86_400_000

/** Met or written to within the deal's lifetime by one of its people: an overlap of people, not a link. */
export type DealTouch = Touch & { standing: Extract<Standing, "proposed"> }

export interface DealContext {
  /** The row as stored: its status is the CRM's or the owner's, and a stage named won is not a payment. */
  deal: Deal
  /** Every stage it entered, oldest first. */
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
  /** The accounts its people's messages, mail and events are read in; left out, every account. */
  accounts?: AccountKey[]
  limit?: number
  /** ms: the end of an open deal's window; the clock when absent. */
  now?: number
}

const notRejected = <T extends { review: string }>(rows: T[]) => rows.filter((row) => row.review !== "rejected")

/**
 * One answer about a deal or a lead from the store: the row, how it moved, its client, people, project, money and
 * what its people said within its lifetime. Nothing is inferred from a stage's name.
 */
export const dealContext = async (
  store: MessageStore,
  reference: string,
  { accounts, limit = SECTION_LIMIT, now = Date.now() }: DealContextOptions = {},
): Promise<DealContext> => {
  const deal = await store.deals.get(reference)
  const { relations, full } = await relationsOf(store, deal.ref)
  const people = relations.filter(
    (relation) => relation.kind === "related-to" && relation.from === deal.ref && relation.to.startsWith("person:"),
  )
  const names = await namesOf(
    store,
    people.map(({ to }) => to),
  )
  const participants = grouped(people, (relation) => relation.to, names)
  const owner =
    participants.find((one) => one.roles.some((role) => role.role === "owner" && isUsable(role.standing))) ?? null

  const organization = deal.organization
  const invoices: [Invoice, LinkedBy][] = []
  const payments: [FinancePayment, LinkedBy][] = []
  for (const [way, filter] of [
    ["project", deal.project === null ? null : { project: deal.project }],
    ["counterparty", organization === null ? null : { counterparty: organization.ref }],
  ] as const) {
    if (filter === null) continue
    for (const invoice of notRejected(await store.finance.invoices({ ...filter, limit: FINANCE_ROWS })))
      invoices.push([invoice, way])
    const party = "counterparty" in filter ? { party: filter.counterparty } : filter
    for (const payment of notRejected(await store.finance.payments({ ...party, limit: FINANCE_ROWS })))
      payments.push([payment, way])
  }

  const since = Date.parse(deal.createdAt)
  const until = deal.closedDate === null ? now : Date.parse(`${deal.closedDate}T00:00:00Z`) + DAY - 1
  const records = []
  for (const one of participants)
    if (one.roles.some((role) => isUsable(role.standing))) {
      const record = await store.people.personByUid(one.ref.slice("person:".length))
      if (record) records.push(record)
    }
  const talks = await communicationsOf(store, records, {
    ...(accounts === undefined ? {} : { accounts }),
    since,
    until,
    limit,
  })
  const stages = await store.deals.stages(deal.ref)
  const about = `about:${deal.ref}`
  return {
    deal,
    stages: sectionOf(stages.slice(-limit), limit, `${deal.kind}s show ${deal.ref}`, stages.length > limit),
    organization:
      organization === null
        ? null
        : {
            ref: organization.ref,
            name: organization.name,
            categories: (await organizationCategories(store)).get(organization.ref) ?? [],
          },
    participants: sectionOf(participants, limit, `relationships list ${about} kind:related-to`, full),
    owner,
    project: deal.project === null ? null : { ref: deal.project, name: deal.projectName },
    money: moneyOf({ invoices, payments }, limit, {
      invoices: `invoices list --project ${deal.project ?? ""}`.trim(),
      payments: `payments list --project ${deal.project ?? ""}`.trim(),
    }),
    window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
    communications: {
      ...sectionOf(
        talks.items.map((touch) => ({ ...touch, standing: "proposed" as const })),
        limit,
        `context ${deal.ref}`,
        talks.hasMore,
      ),
      counts: talks.counts,
    },
    tasks: sectionOf(
      await openTasksOf(store, deal.project === null ? [] : [deal.project]),
      limit,
      `tasks list ${deal.project ?? ""}`.trim(),
    ),
    coverage: await withCrmGaps(store, talks.coverage, accounts),
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
  money: MoneySection["totals"] & { unconfirmed: number }
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
  money: {
    ...context.money.totals,
    unconfirmed:
      context.money.invoices.items.filter((one) => one.review !== "confirmed").length +
      context.money.payments.items.filter((one) => one.review !== "confirmed").length,
  },
  communications: { ...context.communications.counts, standing: "proposed" },
  openTasks: context.tasks.total,
  notRead: context.coverage.notRead,
})
