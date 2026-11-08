import type { ContractKind, ContractStatus, OrderDirection } from "../../domain/business.js"
import type { InvoiceDirection, MoneyDirection } from "../../domain/finance.js"
import type { OrderPurpose, OrderStatus } from "../../domain/orders.js"
import type { InvoiceInput, PaymentInput } from "./finance.js"
import { authorActor } from "./memories.js"
import type { TransactionInput } from "./money-transactions.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import type { OrderInput } from "./orders.js"
import {
  entityOf,
  given,
  IMPORTER,
  importedBy,
  importersProposal,
  moneyLinesOf,
  type Projection,
  type RecordProjector,
  refusal,
  stringField,
} from "./record-projection.js"
import type { SubscriptionInput } from "./subscriptions.js"

const allocatedByOthers = (context: StoreContext, paymentId: number): boolean => {
  const importer = authorActor(context, IMPORTER).actor
  return (
    context.database
      .prepare(
        "SELECT 1 FROM payment_allocations WHERE payment_id = ? AND NOT (author_type = ? AND author_id = ?) LIMIT 1",
      )
      .get(paymentId, importer.type, importer.id) !== undefined
  )
}

/** v1's single roles, which `fields.<role>` may also name as a store ref; roles added later come from relations only. */
const v1Role = (projection: Projection, role: string) =>
  entityOf(projection, role) ?? stringField(projection.fields, role)

const invoiceOf = (projection: Projection): InvoiceInput => {
  const { fields, source } = projection
  if (!Array.isArray(fields.lines) || fields.lines.some((line) => typeof line !== "object" || line === null))
    return refusal("an invoice's fields.lines is a list of lines", "record.invalid")
  return {
    ...importedBy(source),
    direction: fields.direction as InvoiceDirection,
    number: stringField(fields, "number"),
    issuer: v1Role(projection, "issuer"),
    counterparty: v1Role(projection, "counterparty") as string,
    project: v1Role(projection, "project"),
    contract: entityOf(projection, "contract"),
    subscription: entityOf(projection, "subscription"),
    currency: fields.currency as string,
    issueDate: stringField(fields, "issue_date"),
    dueDate: stringField(fields, "due_date"),
    total: fields.total as string | undefined,
    lines: moneyLinesOf(projection, fields.lines),
  }
}

const paymentOf = (projection: Projection): PaymentInput => {
  const { fields, source } = projection
  return {
    ...importedBy(source),
    direction: fields.direction as MoneyDirection,
    payer: v1Role(projection, "payer"),
    payee: v1Role(projection, "payee"),
    project: v1Role(projection, "project"),
    refundOf: entityOf(projection, "refund_of"),
    subscription: entityOf(projection, "subscription"),
    amount: fields.amount as string,
    currency: fields.currency as string,
    date: fields.date as string,
    reference: stringField(fields, "reference"),
  }
}

const orderOf = (projection: Projection): OrderInput => {
  const { fields, source } = projection
  return {
    ...importedBy(source),
    customer: entityOf(projection, "customer"),
    supplier: entityOf(projection, "supplier"),
    project: entityOf(projection, "project"),
    contract: entityOf(projection, "contract"),
    deal: entityOf(projection, "deal"),
    invoice: entityOf(projection, "invoice"),
    payment: entityOf(projection, "payment"),
    purpose: given<OrderPurpose>(fields, "purpose") ?? "business",
    direction: given<OrderDirection>(fields, "direction"),
    status: given<OrderStatus>(fields, "status"),
    supplierName: given(fields, "supplier_name"),
    number: given(fields, "number"),
    orderDate: given(fields, "order_date"),
    fulfilledDate: given(fields, "fulfilled_date"),
    currency: given(fields, "currency"),
    total: given(fields, "total"),
    sourceUrl: given(fields, "source_url"),
    ...(Array.isArray(fields.lines) ? { lines: moneyLinesOf(projection, fields.lines) } : {}),
  }
}

const contractFields = (projection: Projection) => {
  const { fields } = projection
  return {
    name: given<string>(fields, "name") as string,
    kind: given<ContractKind>(fields, "kind") as ContractKind,
    number: given<string>(fields, "number"),
    status: given<ContractStatus>(fields, "status"),
    signedDate: given<string>(fields, "signed_date"),
    effectiveDate: given<string>(fields, "effective_date"),
    expirationDate: given<string>(fields, "expiration_date"),
    autoRenew: given<boolean>(fields, "auto_renew"),
    renewal: given<string>(fields, "renewal"),
    noticeDays: given<number>(fields, "notice_days"),
    terms: given<string>(fields, "terms"),
    value: given<string>(fields, "value"),
    currency: given<string>(fields, "currency"),
    deal: entityOf(projection, "deal"),
  }
}

const subscriptionFields = (projection: Projection) => {
  const { fields } = projection
  return {
    name: given<string>(fields, "name"),
    direction: given<InvoiceDirection>(fields, "direction") as InvoiceDirection,
    supplier: entityOf(projection, "supplier"),
    customer: entityOf(projection, "customer"),
    product: entityOf(projection, "product"),
    contract: entityOf(projection, "contract"),
    status: given<SubscriptionInput["status"]>(fields, "status"),
    every: given<string>(fields, "interval") as string,
    startDate: given<string>(fields, "start_date") as string,
    trialEndDate: given<string>(fields, "trial_end_date"),
    nextRenewalDate: given<string>(fields, "next_renewal_date"),
    cancelledDate: given<string>(fields, "cancelled_date"),
    endDate: given<string>(fields, "end_date"),
  }
}

const pricesOf = (projection: Projection) =>
  (Array.isArray(projection.fields.prices) ? (projection.fields.prices as Record<string, unknown>[]) : []).map(
    (price) => ({
      amount: price.amount as string,
      currency: price.currency as string,
      ...(typeof price.effective_from === "string" ? { effectiveFrom: price.effective_from } : {}),
    }),
  )

const transactionFields = (projection: Projection) => {
  const { fields } = projection
  return {
    direction: fields.direction as MoneyDirection,
    amount: fields.amount as string,
    status: given<TransactionInput["status"]>(fields, "status"),
    statementDate: fields.date as string,
    bookedDate: given<string>(fields, "booked_date"),
    description: given<string>(fields, "description"),
    counterpartyName: given<string>(fields, "counterparty_name"),
    counterparty: entityOf(projection, "counterparty"),
    reference: given<string>(fields, "reference"),
    payment: entityOf(projection, "payment"),
  }
}

const splitsOf = (projection: Projection) =>
  (Array.isArray(projection.fields.splits) ? (projection.fields.splits as Record<string, unknown>[]) : []).map(
    (split) => ({
      amount: split.amount as string,
      category: split.category as string,
      ...(typeof split.note === "string" ? { note: split.note } : {}),
    }),
  )

export const MONEY_PROJECTORS = {
  invoice: { create: (projection, { finance }) => finance.addInvoice(invoiceOf(projection)).ref },
  payment: {
    create: (projection, { finance, settle }) => settle(finance.addPayment(paymentOf(projection)), projection.shares),
    // Only the import's own allocations are taken back: one the owner made on its proposal leaves the change flagged.
    update: (ref, projection, { finance, settle, context }) => {
      const payment = finance.payment(ref)
      if (!importersProposal(payment) || allocatedByOthers(context, requiredThing(context.database, ref).id))
        return false
      for (const { invoice } of payment.allocations) finance.unallocate({ payment: ref, invoice, by: IMPORTER })
      settle(finance.payment(ref), projection.shares)
      return true
    },
  },
  order: {
    create: (projection, { orders }) => orders.add(orderOf(projection)).ref,
    update: (ref, projection, { orders }) => {
      if (!importersProposal(orders.get(ref))) return false
      orders.revise(ref, orderOf(projection))
      return true
    },
  },
  contract: {
    create: (projection, { contracts }) =>
      contracts.add({
        ...importedBy(projection.source),
        ...contractFields(projection),
        project: entityOf(projection, "project"),
      }).ref,
    update: (ref, projection, { contracts }) => {
      if (!importersProposal(contracts.get(ref))) return false
      contracts.update(ref, { by: importedBy(projection.source).by, ...contractFields(projection) })
      return true
    },
  },
  subscription: {
    create: (projection, { subscriptions }) =>
      subscriptions.add({
        ...importedBy(projection.source),
        ...subscriptionFields(projection),
        project: entityOf(projection, "project"),
        prices: pricesOf(projection),
      }).ref,
    update: (ref, projection, { subscriptions }) => {
      const held = subscriptions.get(ref)
      if (!importersProposal(held)) return false
      const { by, source, reason } = importedBy(projection.source)
      subscriptions.update(ref, { by, ...subscriptionFields(projection) })
      const kept = new Set(held.prices.filter((one) => one.review !== "rejected").map((one) => one.effectiveFrom))
      const start = given<string>(projection.fields, "start_date")
      for (const price of pricesOf(projection))
        if (!kept.has(price.effectiveFrom ?? (start as string)))
          subscriptions.addPrice(ref, { ...price, by, source, reason })
      return true
    },
  },
  transaction: {
    create: (projection, { transactions }) =>
      transactions.add({
        ...importedBy(projection.source),
        ...transactionFields(projection),
        wallet: entityOf(projection, "wallet") as string,
        currency: given(projection.fields, "currency"),
        project: entityOf(projection, "project"),
        splits: splitsOf(projection),
      }).ref,
    update: (ref, projection, { transactions }) => {
      const held = transactions.get(ref)
      if (!importersProposal(held)) return false
      const { by } = importedBy(projection.source)
      for (const { position } of held.splits) transactions.removeSplit(ref, { position, by })
      transactions.update(ref, { by, ...transactionFields(projection) })
      for (const split of splitsOf(projection)) transactions.addSplit(ref, { ...split, by })
      return true
    },
  },
} as const satisfies Record<string, RecordProjector>
