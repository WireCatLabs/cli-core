import * as v from "valibot"
import { CATEGORIES } from "../domain/categories.js"
import { DEAL_KINDS, DEAL_STATUSES } from "../domain/deals.js"
import { FINANCE_REVIEWS, INVOICE_DIRECTIONS, INVOICE_STATUSES, MONEY_DIRECTIONS } from "../domain/finance.js"
import { ORDER_STATUSES } from "../domain/orders.js"
import { RELATION_KINDS, STANDINGS } from "../domain/relations.js"
import { TASK_STATES } from "../tasks/index.js"
import { linkedPerson } from "./contact-activity.js"
import { crossAccountContext } from "./contact-context.js"
import { deal } from "./deal.js"
import { count, reference, text, time } from "./fields.js"
import { organization } from "./knowledge-lists.js"

const nullableText = v.nullable(text)
const day = v.nullable(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/)))
const standing = v.picklist(STANDINGS)
const categories = v.array(v.picklist(CATEGORIES))

/** A bounded list: the first items, how many there are, and the memo command that lists the rest. */
const section = <T extends v.GenericSchema>(item: T) =>
  v.strictObject({ items: v.array(item), total: count, has_more: v.boolean(), next: nullableText })

/** One relationship from the entity asked about: a `link:` ref, its role and its standing. */
const relationRole = v.strictObject({
  link: reference,
  kind: v.picklist(RELATION_KINDS),
  role: nullableText,
  /** `reported`: a CRM account says so and nobody confirmed it; `ended`: it no longer holds. */
  standing,
  /** The source account that reported it, `<provider>:<account>`. */
  account: v.optional(text),
  /** A job title the source gave; never a role. */
  position: v.optional(text),
  /** How a source made it when it stated none, such as `department-head`. */
  derived: v.optional(text),
  starts_at: v.optional(time),
  ends_at: v.optional(time),
})
/** Another entity, once, with every relationship joining it to the one asked about. */
const related = v.strictObject({ ref: reference, name: nullableText, roles: v.array(relationRole) })

const coverage = v.strictObject({
  /** `<provider>:<account>` of every account read. */
  accounts: v.array(text),
  not_read: v.array(v.strictObject({ source: text, reason: text })),
})

const linkedBy = v.array(v.picklist(["project", "counterparty"]))
const financeTotal = v.strictObject({
  status: text,
  currency: text,
  rows: count,
  total: text,
  open: v.optional(text),
})
const money = v.strictObject({
  invoices: section(
    v.strictObject({
      ref: reference,
      title: text,
      direction: v.picklist(INVOICE_DIRECTIONS),
      status: v.picklist(INVOICE_STATUSES),
      review: v.picklist(FINANCE_REVIEWS),
      currency: text,
      total: text,
      open: text,
      due_date: day,
      linked_by: linkedBy,
    }),
  ),
  payments: section(
    v.strictObject({
      ref: reference,
      title: text,
      direction: v.picklist(MONEY_DIRECTIONS),
      review: v.picklist(FINANCE_REVIEWS),
      currency: text,
      amount: text,
      date: day,
      linked_by: linkedBy,
    }),
  ),
  orders: v.optional(
    section(
      v.strictObject({
        ref: reference,
        title: text,
        status: v.picklist(ORDER_STATUSES),
        review: v.picklist(FINANCE_REVIEWS),
        currency: nullableText,
        total: nullableText,
        side: v.picklist(["customer", "supplier"]),
      }),
    ),
  ),
  /** Confirmed rows only, per status (payments: direction) and currency; nothing converted. */
  totals: v.strictObject({ invoices: v.array(financeTotal), payments: v.array(financeTotal) }),
})

const taskLine = v.strictObject({
  ref: reference,
  key: text,
  title: text,
  status: v.picklist(TASK_STATES),
  project: reference,
  due_at: v.nullable(time),
})
const counts = { messages: count, mail: count, meetings: count }

/** What a person is in the owner's business: organizations, reporting lines, deals and projects, with standing. */
export const personBusiness = v.strictObject({
  organizations: section(v.strictObject({ ...related.entries, categories })),
  reports_to: section(related),
  direct_reports: section(related),
  deals: section(related),
  projects: section(related),
  categories,
})

/** Any canonical person's context: every account in scope read, their business, and what was not read. */
export const personContext: v.GenericSchema = v.strictObject({
  ...crossAccountContext.entries,
  person: linkedPerson,
  has_more: v.boolean(),
  business: personBusiness,
  coverage,
})

/** One organization: people, customers, suppliers, partners, projects, open deals, money and how much is said. */
export const organizationContext: v.GenericSchema = v.strictObject({
  organization: v.strictObject({ ...organization.entries, own: v.boolean() }),
  categories,
  people: section(related),
  customers: section(related),
  /** Whom it is a customer of: "supplier of", read backwards. */
  suppliers: section(related),
  partners: section(related),
  projects: section(v.strictObject({ ref: reference, name: text, via: v.array(v.picklist(["organization", "deal"])) })),
  deals: section(
    v.strictObject({
      ref: reference,
      kind: v.picklist(DEAL_KINDS),
      title: text,
      summary: text,
      stage: text,
      status: v.picklist(DEAL_STATUSES),
      currency: nullableText,
      amount: nullableText,
      close_date: day,
      project: v.nullable(reference),
    }),
  ),
  money,
  /** Counts only, through its own people, in the accounts read. */
  communications: v.strictObject({ ...counts, has_more: v.boolean() }),
  tasks: section(taskLine),
  coverage,
})

const { untrusted: _, ...dealRow } = deal.entries

/** One deal or lead: the row, its stages, client, people, project, money and what its people said in its time. */
export const dealContext: v.GenericSchema = v.strictObject({
  deal: v.strictObject(dealRow),
  stages: section(v.strictObject({ from: nullableText, to: text, pipeline: reference, at: time })),
  organization: v.nullable(v.strictObject({ ref: reference, name: nullableText, categories })),
  participants: section(related),
  owner: v.nullable(related),
  project: v.nullable(v.strictObject({ ref: reference, name: nullableText })),
  money,
  window: v.strictObject({ since: time, until: time }),
  /** Shared people within its lifetime: `proposed`, an overlap of people, never a link. */
  communications: v.strictObject({
    ...section(
      v.strictObject({
        kind: v.picklist(["message", "mail", "meeting"]),
        ref: reference,
        title: nullableText,
        at: v.nullable(time),
        people: v.array(reference),
        standing: v.literal("proposed"),
      }),
    ).entries,
    counts: v.strictObject(counts),
  }),
  tasks: section(taskLine),
  coverage,
})

/** A deal context's compact form, for a model's context. */
export const dealBrief: v.GenericSchema = v.strictObject({
  ref: reference,
  kind: v.picklist(DEAL_KINDS),
  title: text,
  pipeline: text,
  stage: text,
  status: v.picklist(DEAL_STATUSES),
  amount: nullableText,
  currency: nullableText,
  close_date: day,
  organization: nullableText,
  owner: nullableText,
  people: v.array(v.strictObject({ ref: reference, name: nullableText, roles: v.array(text), standing })),
  project: nullableText,
  stages: v.array(text),
  money: v.strictObject({ ...money.entries.totals.entries, unconfirmed: count }),
  communications: v.strictObject({ ...counts, standing: v.literal("proposed") }),
  open_tasks: count,
  not_read: coverage.entries.not_read,
})
