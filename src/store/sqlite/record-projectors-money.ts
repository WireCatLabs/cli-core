import type { ContractKind, ContractStatus, OrderDirection } from "../../domain/business.js"
import type { InvoiceDirection, MoneyDirection } from "../../domain/finance.js"
import type { OrderPurpose, OrderStatus } from "../../domain/orders.js"
import type { InvoiceInput, PaymentInput } from "./finance.js"
import type { TransactionInput } from "./money-transactions.js"
import type { OrderInput } from "./orders.js"
import {
  given,
  importersProposal,
  linesOf,
  oneOf,
  type Projection,
  type RecordProjector,
  refusal,
  stringField,
  written,
} from "./record-projection.js"
import type { SubscriptionInput } from "./subscriptions.js"

/** v1's single roles, which `fields.<role>` may also name as a store ref; roles added later come from relations only. */
const v1Role = (projection: Projection, role: string) => oneOf(projection, role) ?? stringField(projection.fields, role)

const invoiceOf = (projection: Projection): InvoiceInput => {
  const { fields, source } = projection
  if (!Array.isArray(fields.lines) || fields.lines.some((line) => typeof line !== "object" || line === null))
    return refusal("an invoice's fields.lines is a list of lines", "record.invalid")
  return {
    ...written(source),
    direction: fields.direction as InvoiceDirection,
    number: stringField(fields, "number"),
    issuer: v1Role(projection, "issuer"),
    counterparty: v1Role(projection, "counterparty") as string,
    project: v1Role(projection, "project"),
    contract: oneOf(projection, "contract"),
    subscription: oneOf(projection, "subscription"),
    currency: fields.currency as string,
    issueDate: stringField(fields, "issue_date"),
    dueDate: stringField(fields, "due_date"),
    total: fields.total as string | undefined,
    lines: linesOf(projection, fields.lines),
  }
}

const paymentOf = (projection: Projection): PaymentInput => {
  const { fields, source } = projection
  return {
    ...written(source),
    direction: fields.direction as MoneyDirection,
    payer: v1Role(projection, "payer"),
    payee: v1Role(projection, "payee"),
    project: v1Role(projection, "project"),
    refundOf: oneOf(projection, "refund_of"),
    subscription: oneOf(projection, "subscription"),
    amount: fields.amount as string,
    currency: fields.currency as string,
    date: fields.date as string,
    reference: stringField(fields, "reference"),
  }
}

const orderOf = (projection: Projection): OrderInput => {
  const { fields, source } = projection
  return {
    ...written(source),
    customer: oneOf(projection, "customer"),
    supplier: oneOf(projection, "supplier"),
    project: oneOf(projection, "project"),
    contract: oneOf(projection, "contract"),
    deal: oneOf(projection, "deal"),
    invoice: oneOf(projection, "invoice"),
    payment: oneOf(projection, "payment"),
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
    ...(Array.isArray(fields.lines) ? { lines: linesOf(projection, fields.lines) } : {}),
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
    deal: oneOf(projection, "deal"),
  }
}

const subscriptionFields = (projection: Projection) => {
  const { fields } = projection
  return {
    name: given<string>(fields, "name"),
    direction: given<InvoiceDirection>(fields, "direction") as InvoiceDirection,
    supplier: oneOf(projection, "supplier"),
    customer: oneOf(projection, "customer"),
    product: oneOf(projection, "product"),
    contract: oneOf(projection, "contract"),
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
    counterparty: oneOf(projection, "counterparty"),
    reference: given<string>(fields, "reference"),
    payment: oneOf(projection, "payment"),
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
        ...written(projection.source),
        ...contractFields(projection),
        project: oneOf(projection, "project"),
      }).ref,
    update: (ref, projection, { contracts }) => {
      if (!importersProposal(contracts.get(ref))) return false
      contracts.update(ref, { by: written(projection.source).by, ...contractFields(projection) })
      return true
    },
  },
  subscription: {
    create: (projection, { subscriptions }) =>
      subscriptions.add({
        ...written(projection.source),
        ...subscriptionFields(projection),
        project: oneOf(projection, "project"),
        prices: pricesOf(projection),
      }).ref,
    update: (ref, projection, { subscriptions }) => {
      const held = subscriptions.get(ref)
      if (!importersProposal(held)) return false
      const { by, source, reason } = written(projection.source)
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
        ...written(projection.source),
        ...transactionFields(projection),
        wallet: oneOf(projection, "wallet") as string,
        currency: given(projection.fields, "currency"),
        project: oneOf(projection, "project"),
        splits: splitsOf(projection),
      }).ref,
    update: (ref, projection, { transactions }) => {
      const held = transactions.get(ref)
      if (!importersProposal(held)) return false
      const { by } = written(projection.source)
      for (const { position } of held.splits) transactions.removeSplit(ref, { position, by })
      transactions.update(ref, { by, ...transactionFields(projection) })
      for (const split of splitsOf(projection)) transactions.addSplit(ref, { ...split, by })
      return true
    },
  },
} as const satisfies Record<string, RecordProjector>
