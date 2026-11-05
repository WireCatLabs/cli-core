import * as v from "valibot"
import { INVOICE_DIRECTIONS, MONEY_DIRECTIONS } from "../domain/finance.js"
import { FACT_TYPES, MEMORY_KINDS, MEMORY_SCOPES, WORK_TASK_TYPES } from "../domain/knowledge.js"
import { ORDER_PURPOSES, ORDER_STATUSES } from "../domain/orders.js"
import { author, id, reference, text, time } from "./fields.js"

const evidence = v.strictObject({ reference, fingerprint: text })
const base = { id, evidence: v.array(evidence) }
const finding = v.variant("kind", [
  v.strictObject({
    ...base,
    kind: v.literal("task"),
    project: v.optional(reference),
    type: v.picklist(WORK_TASK_TYPES),
    title: text,
    reason: text,
    commitment: v.picklist(["explicit", "inferred"]),
    due_at: v.optional(time),
    due_evidence: v.optional(v.array(reference)),
    assignee: v.optional(reference),
    assignee_evidence: v.optional(v.array(reference)),
    /** `<service>:<id>` in the outside service the mail came from, such as `avito:4512345678`. */
    external_id: v.optional(text),
    /** The http or https page the task is about, such as the conversation the mail links to. */
    source_url: v.optional(text),
  }),
  v.strictObject({
    ...base,
    kind: v.literal("fact"),
    project: v.optional(reference),
    subject: v.optional(reference),
    type: v.picklist(FACT_TYPES),
    statement: text,
  }),
  v.strictObject({
    ...base,
    kind: v.literal("task_update"),
    task: reference,
    change: v.picklist(["close", "due", "detail"]),
    due_at: v.optional(time),
    detail: v.optional(text),
    reason: text,
  }),
  v.strictObject({
    ...base,
    kind: v.literal("memory"),
    memory_kind: v.picklist(MEMORY_KINDS),
    scope: v.picklist(MEMORY_SCOPES),
    body: text,
    subject: v.optional(reference),
    project: v.optional(reference),
  }),
  v.strictObject({ ...base, kind: v.literal("link"), from: reference, to: reference, reason: text }),
  v.strictObject({ ...base, kind: v.literal("new_contact"), address: text, name: text, reason: v.optional(text) }),
  v.strictObject({
    ...base,
    kind: v.literal("invoice"),
    direction: v.picklist(INVOICE_DIRECTIONS),
    counterparty: v.optional(reference),
    /** A counterparty the store may not hold yet; the owner's accept finds its organization or makes one. */
    counterparty_name: v.optional(text),
    counterparty_email: v.optional(text),
    currency: text,
    lines: v.array(
      v.strictObject({
        description: text,
        quantity: v.optional(text),
        unit_price: v.optional(text),
        amount: v.optional(text),
      }),
    ),
    total: v.optional(text),
    number: v.optional(text),
    issue_date: v.optional(text),
    due_date: v.optional(text),
    project: v.optional(reference),
    reason: text,
  }),
  v.strictObject({
    ...base,
    kind: v.literal("payment"),
    direction: v.picklist(MONEY_DIRECTIONS),
    payer: v.optional(reference),
    payer_name: v.optional(text),
    payer_email: v.optional(text),
    payee: v.optional(reference),
    payee_name: v.optional(text),
    payee_email: v.optional(text),
    amount: text,
    currency: text,
    date: text,
    reference: v.optional(text),
    allocations: v.optional(v.array(v.strictObject({ invoice: reference, amount: text }))),
    project: v.optional(reference),
    reason: text,
  }),
  v.strictObject({
    ...base,
    kind: v.literal("order"),
    purpose: v.picklist(ORDER_PURPOSES),
    customer: v.optional(reference),
    customer_name: v.optional(text),
    customer_email: v.optional(text),
    supplier: v.optional(reference),
    supplier_name: text,
    number: v.optional(text),
    total: v.optional(text),
    currency: v.optional(text),
    status: v.optional(v.picklist(ORDER_STATUSES)),
    order_date: v.optional(text),
    fulfilled_date: v.optional(text),
    invoice: v.optional(reference),
    payment: v.optional(reference),
    project: v.optional(reference),
    /** The order's page at the shop, http or https. */
    source_url: v.optional(text),
    reason: text,
  }),
  v.strictObject({
    ...base,
    kind: v.literal("order_update"),
    supplier_name: text,
    number: text,
    status: v.picklist(ORDER_STATUSES),
    date: v.optional(text),
    reason: text,
  }),
])
const outcome = v.strictObject({
  id,
  fingerprint: text,
  status: v.picklist(["accepted", "rejected"]),
  reference: v.nullable(reference),
  reused: v.boolean(),
})
/** A mail findings batch: what an agent read in one mailbox's new mail, waiting for the owner. */
export const mailFindings = v.strictObject({
  id,
  account: v.strictObject({ provider: text, account: text }),
  input: v.strictObject({ schema_version: v.literal(1), key: text, extractor: text, findings: v.array(finding) }),
  fingerprint: text,
  status: v.picklist(["proposed", "reviewed"]),
  author,
  decided_by: v.nullable(v.strictObject({ type: v.picklist(["person", "bot"]), id })),
  decided_at: v.nullable(time),
  previous: v.array(outcome),
  receipt: v.nullable(v.strictObject({ preview_fingerprint: text, accepted: v.array(id), items: v.array(outcome) })),
})
