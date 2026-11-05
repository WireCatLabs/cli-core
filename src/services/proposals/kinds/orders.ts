import type { MessageStore, Order } from "../../../store/index.js"
import type { ProposalKind, ProposalRow } from "../types.js"
import { kept, proposerOfAuthor, pushed } from "./shared.js"

const rowOf = (order: Order): ProposalRow => ({
  id: order.ref,
  kind: "order",
  status: order.review,
  project: order.project,
  subject: order.ref,
  object: order.supplier?.ref ?? null,
  summary: order.title,
  proposedBy: proposerOfAuthor(order.author),
  reason: order.reason,
  evidence: [],
  score: null,
  signals: null,
  parts: null,
  createdAt: order.createdAt,
})

/** An agent's order, by its own ref (`order:12`) as invoices are; only the owner decides it. */
export const orderKind = (store: Pick<MessageStore, "orders">): ProposalKind => ({
  kind: "order",
  prefix: "order",
  list: async (filter) => {
    const status = filter.status ?? "proposed"
    const orders = await store.orders.list({ ...pushed(filter), ...(status === "all" ? {} : { review: status }) })
    return kept(orders.map(rowOf), filter)
  },
  get: async (id) => rowOf(await store.orders.get(id)),
  decide: async (id, { confirm, by, reason }) => {
    const order = confirm ? await store.orders.confirm(id, by, reason) : await store.orders.reject(id, by, reason)
    return { id, kind: "order", status: confirm ? "confirmed" : "rejected", made: confirm ? [order.ref] : [] }
  },
})
