import { CliError } from "@wirecat/cli-base"
import { INVOICE_DIRECTIONS, MONEY_DIRECTIONS } from "../domain/finance.js"
import { MEMORY_KINDS, MEMORY_SCOPES } from "../domain/knowledge.js"
import { formatLocator, parseLocator } from "../domain/locator.js"
import { ORDER_PURPOSES, ORDER_STATUSES } from "../domain/orders.js"
import { parseReference } from "../domain/references.js"
import {
  type FactFinding,
  type FindingEvidence,
  type FindingsRules,
  findingFields,
  findingHash,
  findingId,
  findingText,
  meetingTimestamp,
  type TaskFinding,
  validateBatch,
  validateFinding,
  validEvidence,
} from "../meetings/index.js"

export { MAIL_FINDINGS_KIND } from "../store/mail-findings.js"
/** At most this many findings in one run's batch, and per sender in it. */
export const MAIL_FINDINGS_PER_RUN = 30
export const MAIL_FINDINGS_PER_SENDER = 5

interface Cited {
  id: string
  evidence: FindingEvidence[]
}
export type MailTaskFinding = TaskFinding
export type MailFactFinding = FactFinding
export interface MailTaskUpdateFinding extends Cited {
  kind: "task_update"
  task: string
  change: "close" | "due" | "detail"
  dueAt?: string
  detail?: string
  reason: string
}
export interface MailMemoryFinding extends Cited {
  kind: "memory"
  memoryKind: (typeof MEMORY_KINDS)[number]
  scope: (typeof MEMORY_SCOPES)[number]
  body: string
  subject?: string
  project?: string
}
/** Address → person, person → organization, or thread → project. */
export interface MailLinkFinding extends Cited {
  kind: "link"
  from: string
  to: string
  reason: string
}
export interface MailNewContactFinding extends Cited {
  kind: "new_contact"
  address: string
  name: string
  reason?: string
}
/** An invoice the mail carries; accepting it records the invoice through `store.finance`, confirmed. */
export interface MailInvoiceFinding extends Cited {
  kind: "invoice"
  direction: (typeof INVOICE_DIRECTIONS)[number]
  /** `person:` or `organization:`. */
  counterparty: string
  currency: string
  lines: { description: string; quantity?: string; unitPrice?: string; amount?: string }[]
  /** The total printed on it: the store refuses it unless it is the lines' sum. */
  total?: string
  number?: string
  issueDate?: string
  dueDate?: string
  project?: string
  reason: string
}
/** A payment the mail confirms, such as a receipt; accepting it records the payment through `store.finance`. */
export interface MailPaymentFinding extends Cited {
  kind: "payment"
  direction: (typeof MONEY_DIRECTIONS)[number]
  payer?: string
  payee?: string
  amount: string
  currency: string
  /** `YYYY-MM-DD`. */
  date: string
  /** The payment's own reference text, such as the receipt number. */
  reference?: string
  /** Stored invoices it settles, in the payment's currency. */
  allocations?: { invoice: string; amount: string }[]
  project?: string
  reason: string
}
/** An order the mail confirms; accepting it records the order through `store.orders`. */
export interface MailOrderFinding extends Cited {
  kind: "order"
  purpose: (typeof ORDER_PURPOSES)[number]
  /** Whom it is for; the owner when left out. */
  customer?: string
  supplier?: string
  supplierName: string
  number?: string
  total?: string
  currency?: string
  status?: (typeof ORDER_STATUSES)[number]
  orderDate?: string
  fulfilledDate?: string
  invoice?: string
  payment?: string
  project?: string
  reason: string
}
/** A later mail about a stored order, found by its shop and number: shipped, delivered, cancelled, returned. */
export interface MailOrderUpdateFinding extends Cited {
  kind: "order_update"
  supplierName: string
  number: string
  status: (typeof ORDER_STATUSES)[number]
  /** `YYYY-MM-DD`, the delivery day of a delivered order. */
  date?: string
  reason: string
}
export type MailFinding =
  | MailTaskFinding
  | MailFactFinding
  | MailTaskUpdateFinding
  | MailMemoryFinding
  | MailLinkFinding
  | MailNewContactFinding
  | MailInvoiceFinding
  | MailPaymentFinding
  | MailOrderFinding
  | MailOrderUpdateFinding

export interface MailFindingsInput {
  schemaVersion: 1
  /** `<holder>:<through_id>`: one batch per run of a holder over the mail it was given. */
  key: string
  extractor: string
  findings: MailFinding[]
}

const invalid = (message: string): never => {
  throw new CliError("validation_error", message)
}

const emailEvidence = (raw: string): string => {
  try {
    const locator = parseLocator(raw)
    if (locator.provider === "email") return formatLocator(locator)
  } catch {}
  return invalid("mail finding evidence is a msg:email/… reference")
}

const RULES: FindingsRules = {
  plural: "mail findings",
  singular: "mail finding",
  cited: "reference",
  reference: emailEvidence,
  anySubject: true,
  inboxTasks: true,
}

const typeOf = (reference: string): string | undefined => {
  try {
    const parsed = parseReference(reference)
    return parsed.type === "contact" || parsed.type === "chat" ? `${parsed.type}:${parsed.provider}` : parsed.type
  } catch {
    return undefined
  }
}

const LINKS: Record<string, string> = {
  "contact:email": "person",
  person: "organization",
  "chat:email": "project",
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/
const PARTY = /^(person|organization):[1-9]\d*$/
const INVOICE = /^invoice:[1-9]\d*$/
const PAYMENT = /^payment:[1-9]\d*$/
const PROJECT = /^project:[1-9]\d*$/

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], what: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) return invalid(`${what} is ${allowed.join(", ")}`)
  return value as T
}

/** Money and dates stay text here: the store's finance and order services check them as they check the owner's. */
const word = (value: unknown, limit: number) => findingText(value, limit)

const optional = <K extends string, V>(key: K, value: unknown, read: (value: unknown) => V): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: read(value) }) as { [P in K]?: V }

const one = (raw: Record<string, unknown>, ids: Set<string>): MailFinding => {
  if (!raw || typeof raw !== "object") return invalid("a finding is an object")
  if (raw.kind === "task" || raw.kind === "fact") return validateFinding(raw as never, RULES, ids) as MailFinding
  const id = findingId(raw.id, ids)
  const evidence = validEvidence(raw.evidence, RULES)
  const reference = (value: unknown, pattern: RegExp, what: string) => {
    const text = findingText(value, 400)
    if (!pattern.test(text)) return invalid(`${what} is not a reference of the kind it takes: ${text}`)
    return text
  }
  switch (raw.kind) {
    case "task_update": {
      findingFields(raw, ["id", "kind", "task", "change", "dueAt", "detail", "reason", "evidence"], RULES.singular)
      const task = reference(raw.task, /^task:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "a task update's task")
      const change = raw.change
      if (change !== "close" && change !== "due" && change !== "detail")
        return invalid("a task update's change is close, due or detail")
      if ((change === "due") !== (raw.dueAt !== undefined)) return invalid("a due change, and only it, gives due_at")
      if ((change === "detail") !== (raw.detail !== undefined))
        return invalid("a detail change, and only it, gives detail")
      return {
        id,
        kind: "task_update",
        task,
        change,
        ...(raw.dueAt === undefined
          ? {}
          : { dueAt: meetingTimestamp(raw.dueAt as string, "a task update's due date") }),
        ...(raw.detail === undefined ? {} : { detail: findingText(raw.detail, 2000) }),
        reason: findingText(raw.reason, 2000),
        evidence,
      }
    }
    case "memory": {
      findingFields(
        raw,
        ["id", "kind", "memoryKind", "scope", "body", "subject", "project", "evidence"],
        RULES.singular,
      )
      if (!MEMORY_KINDS.includes(raw.memoryKind as never))
        return invalid(`a memory's memory_kind is ${MEMORY_KINDS.join(", ")}`)
      if (!MEMORY_SCOPES.includes(raw.scope as never)) return invalid("a memory's scope is personal or work")
      if (raw.subject === undefined && raw.project === undefined)
        return invalid("a memory is about a subject or a project")
      return {
        id,
        kind: "memory",
        memoryKind: raw.memoryKind as MailMemoryFinding["memoryKind"],
        scope: raw.scope as MailMemoryFinding["scope"],
        body: findingText(raw.body, 20_000),
        ...(raw.subject === undefined
          ? {}
          : { subject: reference(raw.subject, /^(person|organization|project):[1-9]\d*$/, "a memory's subject") }),
        ...(raw.project === undefined ? {} : { project: reference(raw.project, /^project:[1-9]\d*$/, "a project") }),
        evidence,
      }
    }
    case "link": {
      findingFields(raw, ["id", "kind", "from", "to", "reason", "evidence"], RULES.singular)
      const from = findingText(raw.from, 400)
      const to = findingText(raw.to, 80)
      const wanted = LINKS[typeOf(from) ?? ""]
      if (!wanted || typeOf(to) !== wanted || !/:[1-9]\d*$/.test(to))
        return invalid(
          "a link goes from contact:email/<address> to person:, person: to organization:, or chat:email/… to project:",
        )
      return { id, kind: "link", from, to, reason: findingText(raw.reason, 2000), evidence }
    }
    case "new_contact": {
      findingFields(raw, ["id", "kind", "address", "name", "reason", "evidence"], RULES.singular)
      const address = findingText(raw.address, 320).toLowerCase()
      if (!ADDRESS.test(address)) return invalid("a new contact's address is an email address")
      return {
        id,
        kind: "new_contact",
        address,
        name: findingText(raw.name, 200),
        ...(raw.reason === undefined ? {} : { reason: findingText(raw.reason, 2000) }),
        evidence,
      }
    }
    case "invoice": {
      findingFields(
        raw,
        [
          "id",
          "kind",
          "direction",
          "counterparty",
          "currency",
          "lines",
          "total",
          "number",
          "issueDate",
          "dueDate",
          "project",
          "reason",
          "evidence",
        ],
        RULES.singular,
      )
      if (!Array.isArray(raw.lines) || raw.lines.length < 1 || raw.lines.length > 50)
        return invalid("an invoice finding has 1–50 lines")
      const lines = raw.lines.map((line: unknown) => {
        if (!line || typeof line !== "object") return invalid("an invoice line is an object")
        const fields = line as Record<string, unknown>
        findingFields(fields, ["description", "quantity", "unitPrice", "amount"], "invoice line")
        return {
          description: word(fields.description, 500),
          ...optional("quantity", fields.quantity, (value) => word(value, 20)),
          ...optional("unitPrice", fields.unitPrice, (value) => word(value, 30)),
          ...optional("amount", fields.amount, (value) => word(value, 30)),
        }
      })
      return {
        id,
        kind: "invoice",
        direction: oneOf(raw.direction, INVOICE_DIRECTIONS, "an invoice's direction"),
        counterparty: reference(raw.counterparty, PARTY, "an invoice's counterparty"),
        currency: word(raw.currency, 3),
        lines,
        ...optional("total", raw.total, (value) => word(value, 30)),
        ...optional("number", raw.number, (value) => word(value, 80)),
        ...optional("issueDate", raw.issueDate, (value) => word(value, 10)),
        ...optional("dueDate", raw.dueDate, (value) => word(value, 10)),
        ...optional("project", raw.project, (value) => reference(value, PROJECT, "a project")),
        reason: findingText(raw.reason, 2000),
        evidence,
      }
    }
    case "payment": {
      findingFields(
        raw,
        [
          "id",
          "kind",
          "direction",
          "payer",
          "payee",
          "amount",
          "currency",
          "date",
          "reference",
          "allocations",
          "project",
          "reason",
          "evidence",
        ],
        RULES.singular,
      )
      let allocations: MailPaymentFinding["allocations"]
      if (raw.allocations !== undefined) {
        if (!Array.isArray(raw.allocations) || raw.allocations.length < 1 || raw.allocations.length > 8)
          return invalid("a payment finding's allocations are 1–8 invoices it settles")
        allocations = raw.allocations.map((share: unknown) => {
          if (!share || typeof share !== "object") return invalid("an allocation is an invoice and an amount")
          const fields = share as Record<string, unknown>
          findingFields(fields, ["invoice", "amount"], "allocation")
          return {
            invoice: reference(fields.invoice, INVOICE, "an allocation's invoice"),
            amount: word(fields.amount, 30),
          }
        })
      }
      return {
        id,
        kind: "payment",
        direction: oneOf(raw.direction, MONEY_DIRECTIONS, "a payment's direction"),
        ...optional("payer", raw.payer, (value) => reference(value, PARTY, "a payment's payer")),
        ...optional("payee", raw.payee, (value) => reference(value, PARTY, "a payment's payee")),
        amount: word(raw.amount, 30),
        currency: word(raw.currency, 3),
        date: word(raw.date, 10),
        ...optional("reference", raw.reference, (value) => word(value, 500)),
        ...(allocations === undefined ? {} : { allocations }),
        ...optional("project", raw.project, (value) => reference(value, PROJECT, "a project")),
        reason: findingText(raw.reason, 2000),
        evidence,
      }
    }
    case "order": {
      findingFields(
        raw,
        [
          "id",
          "kind",
          "purpose",
          "customer",
          "supplier",
          "supplierName",
          "number",
          "total",
          "currency",
          "status",
          "orderDate",
          "fulfilledDate",
          "invoice",
          "payment",
          "project",
          "reason",
          "evidence",
        ],
        RULES.singular,
      )
      return {
        id,
        kind: "order",
        purpose: oneOf(raw.purpose, ORDER_PURPOSES, "an order's purpose"),
        ...optional("customer", raw.customer, (value) => reference(value, PARTY, "an order's customer")),
        ...optional("supplier", raw.supplier, (value) => reference(value, PARTY, "an order's supplier")),
        supplierName: word(raw.supplierName, 200),
        ...optional("number", raw.number, (value) => word(value, 80)),
        ...optional("total", raw.total, (value) => word(value, 30)),
        ...optional("currency", raw.currency, (value) => word(value, 3)),
        ...optional("status", raw.status, (value) => oneOf(value, ORDER_STATUSES, "an order's status")),
        ...optional("orderDate", raw.orderDate, (value) => word(value, 10)),
        ...optional("fulfilledDate", raw.fulfilledDate, (value) => word(value, 10)),
        ...optional("invoice", raw.invoice, (value) => reference(value, INVOICE, "an order's invoice")),
        ...optional("payment", raw.payment, (value) => reference(value, PAYMENT, "an order's payment")),
        ...optional("project", raw.project, (value) => reference(value, PROJECT, "a project")),
        reason: findingText(raw.reason, 2000),
        evidence,
      }
    }
    case "order_update": {
      findingFields(
        raw,
        ["id", "kind", "supplierName", "number", "status", "date", "reason", "evidence"],
        RULES.singular,
      )
      const status = oneOf(raw.status, ORDER_STATUSES, "an order update's status")
      if (raw.date !== undefined && status !== "delivered") return invalid("only a delivered order update gives date")
      return {
        id,
        kind: "order_update",
        supplierName: word(raw.supplierName, 200),
        number: word(raw.number, 80),
        status,
        ...optional("date", raw.date, (value) => word(value, 10)),
        reason: findingText(raw.reason, 2000),
        evidence,
      }
    }
    default:
      return invalid(
        "a mail finding is a task, task_update, fact, memory, link, new_contact, invoice, payment, order or order_update",
      )
  }
}

/**
 * The shape of a mail findings batch: 1–30 findings, each citing 1–8 `msg:email/…` references with fingerprints.
 * What needs the store — the fingerprints, partial mail, the per-sender cap, the targets — the store checks.
 */
export const validateMailFindings = (input: MailFindingsInput): MailFindingsInput => {
  const batch = validateBatch(input, RULES, MAIL_FINDINGS_PER_RUN, one)
  if (!/^[a-z0-9][a-z0-9-]{0,39}:[1-9]\d*$/.test(batch.key))
    return invalid("a mail findings key is <holder>:<through_id>, such as mail-triage:9123456")
  return batch
}

export const mailFindingFingerprint = ({ id: _id, ...finding }: MailFinding): string => findingHash(finding)
