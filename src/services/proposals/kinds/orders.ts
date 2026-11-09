import type { MessageStore, Order } from "../../../store/index.js"
import type { ProposalKind } from "../types.js"
import { reviewedKind, reviewedRow } from "./shared.js"

/** An agent's order, by its own ref (`order:12`) as invoices are; only the owner decides it. */
export const orderKind = (store: Pick<MessageStore, "orders">): ProposalKind =>
  reviewedKind<Order>({
    type: "order",
    list: (options) => store.orders.list(options),
    get: (id) => store.orders.get(id),
    row: (order) =>
      reviewedRow("order", order, (order.direction === "sale" ? order.customer : order.supplier)?.ref ?? null),
    decide: async (id, confirm, { by, reason }) =>
      (confirm ? await store.orders.confirm(id, by, reason) : await store.orders.reject(id, by, reason)).ref,
  })
