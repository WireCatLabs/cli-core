import { CliError } from "@wirecat/cli-base"
import type { ProposalType, RecordEntityType } from "../../domain/record-types.js"
import type { EnvelopeSource } from "../../domain/records.js"
import type { financeOperationsOver, InvoiceInput, PaymentDetail, PaymentInput } from "./finance.js"
import type { Author } from "./memories.js"

export type Row = Record<string, unknown>

export interface Share {
  invoice: string
  /** As the source gave it; `null` settles as far as both allow. */
  amount: string | null
}

/** The entities a record's relations resolved to, by role, and what each invoice a payment settles gets. */
export interface Related {
  related: Map<string, string[]>
  shares: Share[]
}

export interface ProjectionTools {
  finance: ReturnType<typeof financeOperationsOver>
  settle: (made: PaymentDetail, shares: Share[]) => string
}

/** Makes the proposal a record stands for and returns its ref. */
export type Projector = (fields: Row, related: Related, source: EnvelopeSource, tools: ProjectionTools) => string

export const IMPORTER = { bot: "import" } as const satisfies Author

/** `at` names the record's member at fault; a refused entity is the fields' fault. */
export const refusal = (message: string, code: string, at?: string | (string | number)[]): never => {
  throw new CliError("validation_error", message, { reason: code, ...(at === undefined ? {} : { at }) })
}

export const stringField = (fields: Row, name: string): string | undefined => {
  const value = fields[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") return refusal(`fields.${name} is text`, "record.invalid")
  return value
}

const written = (source: EnvelopeSource) => ({
  by: IMPORTER,
  source: `import:${source.provider}`,
  reason: `imported from ${source.provider} account ${source.account}, batch ${source.batch_id}`,
})

const invoiceOf = (fields: Row, related: Map<string, string[]>, source: EnvelopeSource): InvoiceInput => {
  if (!Array.isArray(fields.lines) || fields.lines.some((line) => typeof line !== "object" || line === null))
    return refusal("an invoice's fields.lines is a list of lines", "record.invalid")
  const one = (role: string) => related.get(role)?.[0] ?? stringField(fields, role)
  return {
    ...written(source),
    direction: fields.direction as InvoiceInput["direction"],
    number: stringField(fields, "number"),
    issuer: one("issuer"),
    counterparty: one("counterparty") as string,
    project: one("project"),
    currency: fields.currency as string,
    issueDate: stringField(fields, "issue_date"),
    dueDate: stringField(fields, "due_date"),
    total: fields.total as string | undefined,
    lines: (fields.lines as Row[]).map((line) => ({
      description: line.description as string,
      quantity: line.quantity as string | undefined,
      unitPrice: line.unit_price as string | undefined,
      amount: line.amount as string | undefined,
    })),
  }
}

const paymentOf = (fields: Row, related: Map<string, string[]>, source: EnvelopeSource): PaymentInput => {
  const one = (role: string) => related.get(role)?.[0] ?? stringField(fields, role)
  return {
    ...written(source),
    direction: fields.direction as PaymentInput["direction"],
    payer: one("payer"),
    payee: one("payee"),
    project: one("project"),
    amount: fields.amount as string,
    currency: fields.currency as string,
    date: fields.date as string,
    reference: stringField(fields, "reference"),
  }
}

/** `null` for a type whose entity only the owner's `map` gives. */
export const RECORD_PROJECTORS: { [K in RecordEntityType]: K extends ProposalType ? Projector : null } = {
  invoice: (fields, { related }, source, { finance }) => finance.addInvoice(invoiceOf(fields, related, source)).ref,
  payment: (fields, { related, shares }, source, { finance, settle }) =>
    settle(finance.addPayment(paymentOf(fields, related, source)), shares),
  person: null,
  organization: null,
  project: null,
}
