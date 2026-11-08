import { CliError } from "@wirecat/cli-base"
import type { RecordEntityType } from "../../domain/record-types.js"
import type { EnvelopeOptions, EnvelopeSource } from "../../domain/records.js"
import type { contractOperationsOver } from "./business-contracts.js"
import type { crmRowsOver } from "./crm.js"
import type { financeOperationsOver, PaymentDetail } from "./finance.js"
import type { Author } from "./memories.js"
import type { transactionOperationsOver } from "./money-transactions.js"
import type { StoreContext } from "./open.js"
import type { orderOperationsOver } from "./orders.js"
import type { productOperationsOver } from "./products.js"
import type { Reviewed } from "./reviewed.js"
import type { subscriptionOperationsOver } from "./subscriptions.js"
import type { walletOperationsOver } from "./wallets.js"

export type Row = Record<string, unknown>

export interface Share {
  invoice: string
  /** As the source gave it; `null` settles as far as both allow. */
  amount: string | null
}

/** What a record stands for, with every reference it makes resolved to an entity. */
export interface Projection {
  externalId: string
  accountId: number
  source: EnvelopeSource
  options: EnvelopeOptions
  fields: Row
  /** The entities its relations resolved to, by role, in the order sent. */
  related: Map<string, string[]>
  /** The `as` of each relation in `related`, by role and in the same order. */
  as: Map<string, (string | null)[]>
  /** What each invoice a payment settles gets. */
  shares: Share[]
  /** `product:` refs of the product records its lines name by external id; empty when it names none. */
  products: Map<string, string>
}

export interface ProjectionTools {
  context: StoreContext
  finance: ReturnType<typeof financeOperationsOver>
  orders: ReturnType<typeof orderOperationsOver>
  contracts: ReturnType<typeof contractOperationsOver>
  subscriptions: ReturnType<typeof subscriptionOperationsOver>
  transactions: ReturnType<typeof transactionOperationsOver>
  products: ReturnType<typeof productOperationsOver>
  wallets: ReturnType<typeof walletOperationsOver>
  crm: ReturnType<typeof crmRowsOver>
  settle: (made: PaymentDetail, shares: Share[]) => string
}

export interface RecordProjector {
  /** Makes the entity or the proposal the record stands for and returns its ref. */
  create(projection: Projection, tools: ProjectionTools): string
  /**
   * Takes a changed record into the entity it made, while that is the import's to change: `false` when the owner
   * decided it, and the change is only flagged. Left out, every change is flagged.
   */
  update?(ref: string, projection: Projection, tools: ProjectionTools): boolean
}

export const IMPORTER = { bot: "import" } as const satisfies Author

/** A proposal the import made that the owner has not decided yet: the import may still change it. */
export const importersProposal = (entity: Pick<Reviewed, "review" | "author">) =>
  entity.review === "proposed" && entity.author.type === "bot" && entity.author.name === IMPORTER.bot

/** The stable word a store refusal carries, for the receipt. */
export const codeOf = (error: CliError): string => {
  const reason = (error.details as { reason?: unknown } | undefined)?.reason
  if (typeof reason === "string") return reason
  return error.code === "not_found" ? "record.reference-not-found" : "record.entity"
}

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

/** A field the registry's schema already typed, read without a second check. */
export const given = <T>(fields: Row, name: string): T | undefined =>
  fields[name] === undefined || fields[name] === null ? undefined : (fields[name] as T)

export const importedBy = (source: EnvelopeSource) => ({
  by: IMPORTER,
  source: `import:${source.provider}`,
  reason: `imported from ${source.provider} account ${source.account}, batch ${source.batch_id}`,
})

/** The one entity a single role resolved to. */
export const entityOf = (projection: Projection, role: string): string | undefined => projection.related.get(role)?.[0]

/** A line's product: the product record it names in this account, or a `product:` ref. */
const productOf = (projection: Projection, line: Row): string | undefined => {
  if (typeof line.product_ref === "string") return line.product_ref
  if (typeof line.product === "string") return projection.products.get(line.product)
  return undefined
}

export const moneyLinesOf = (projection: Projection, list: unknown) =>
  (Array.isArray(list) ? (list as Row[]) : []).map((line) => {
    const product = productOf(projection, line)
    return {
      description: given<string>(line, "description") as string,
      quantity: given<string>(line, "quantity"),
      unitPrice: given<string>(line, "unit_price"),
      amount: given<string>(line, "amount"),
      ...(product === undefined ? {} : { product }),
    }
  })

export type RecordProjectors = Record<RecordEntityType, RecordProjector | null>
