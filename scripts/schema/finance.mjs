import { actor, c, del, fk, id, meta, ts } from "./columns.mjs"

export const MINOR = "in minor units of `currency` (kopecks, cents; yen for JPY): never a float"
const PARTY = "`person` or `organization`"

// Who wrote a row and whether the owner stands behind it, as `facts` keeps it; `status` is the invoice's own.
export const reviewed = () => [
  c("review", "text", {
    notnull: true,
    note: "proposed, confirmed, rejected: the owner's entry is confirmed at once, an agent's or an import's waits",
  }),
  ...actor("author", { notnull: true }),
  c("model", "text", { note: "the model that wrote it, for an agent's" }),
  ...actor("confirmed_by", { note: "who confirmed it; null while proposed" }),
  c("source", "text", { notnull: true, note: "owner, agent, an import" }),
  meta(),
]

export const financeTables = [
  {
    name: "invoices",
    doc: "An invoice the owner issued or received. Its lines are `invoice_lines` and its total is their sum; its status follows the confirmed payments allocated to it.",
    cols: [
      id(),
      c("direction", "text", { notnull: true, note: "receivable (owed to the owner), payable (the owner owes)" }),
      c("number", "text", { note: "the number printed on it" }),
      c("issuer_type", "text", { note: PARTY }),
      c("issuer_id", "integer"),
      c("counterparty_type", "text", { notnull: true, note: PARTY }),
      c("counterparty_id", "integer", { notnull: true }),
      fk("project_id", "projects"),
      c("currency", "text", { notnull: true, note: "ISO 4217, upper case" }),
      c("total", "integer", { notnull: true, note: `the sum of its lines, ${MINOR}` }),
      c("issue_date", "text", { note: "`YYYY-MM-DD`" }),
      c("due_date", "text", { note: "`YYYY-MM-DD`" }),
      c("status", "text", {
        notnull: true,
        note: "draft, issued, partly_paid, paid, void: the store derives it from confirmed allocations; only void and draft → issued are set",
      }),
      ...reviewed(),
      ...ts(),
      del(),
      fk("contract_id", "contracts", { note: "the contract it bills under" }),
      fk("subscription_id", "subscriptions", { note: "the subscription whose period it bills" }),
    ],
  },
  {
    name: "invoice_lines",
    doc: "One line of an invoice, in its currency.",
    cols: [
      id(),
      fk("invoice_id", "invoices", { notnull: true }),
      c("position", "integer", { notnull: true, note: "1, 2, …, in the order the invoice lists them" }),
      c("description", "text", { notnull: true }),
      c("quantity", "text", { notnull: true, note: "a decimal as text, `1` or `1.5`: never a float" }),
      c("unit_price", "integer", { note: `${MINOR}; null when only the line's amount is known` }),
      c("amount", "integer", { notnull: true, note: `quantity × unit price, half rounded up, ${MINOR}` }),
      ...ts(),
      fk("catalog_item_id", "catalog_items", { note: "the item it bills, when known; its price is copied" }),
    ],
    keys: ["UNIQUE (invoice_id, position)"],
  },
  {
    name: "payments",
    doc: "Money that moved to or from the owner. A refund is a payment the other way with `refund_of`, allocated only to an invoice its payment is allocated to; paid is net of confirmed refunds.",
    cols: [
      id(),
      c("direction", "text", { notnull: true, note: "in (to the owner), out (from the owner)" }),
      c("payer_type", "text", { note: PARTY }),
      c("payer_id", "integer"),
      c("payee_type", "text", { note: PARTY }),
      c("payee_id", "integer"),
      c("amount", "integer", { notnull: true, note: `more than 0, ${MINOR}` }),
      c("currency", "text", { notnull: true, note: "ISO 4217, upper case" }),
      c("payment_date", "text", { notnull: true, note: "`YYYY-MM-DD`" }),
      c("reference", "text", { note: "the payment's reference text, as the bank or the payer wrote it" }),
      fk("project_id", "projects"),
      ...reviewed(),
      ...ts(),
      del(),
      fk("refund_of", "payments", {
        note: "the payment this refunds: the other direction, the same currency, never more than it",
      }),
      fk("subscription_id", "subscriptions", { note: "the subscription it pays, with or without an invoice" }),
    ],
  },
  {
    name: "payment_allocations",
    doc: "How much of a payment settles an invoice. A payment's allocations never exceed it, an invoice's never exceed its total, and both sides share one currency (triggers refuse the rest). Only a confirmed payment's allocations count towards the invoice's status.",
    cols: [
      id(),
      fk("payment_id", "payments", { notnull: true }),
      fk("invoice_id", "invoices", { notnull: true }),
      c("amount", "integer", { notnull: true, note: `more than 0, ${MINOR}` }),
      ...actor("author", { notnull: true }),
      ...ts(),
    ],
    keys: ["UNIQUE (payment_id, invoice_id)"],
  },
  {
    name: "orders",
    doc: "An order the owner placed with a shop or a supplier, or took from a client: for whom, from whom, its number, amount and how far delivery got. The mail-triage agent proposes them from order and delivery mail.",
    cols: [
      id(),
      c("customer_type", "text", {
        notnull: true,
        note: `${PARTY}: whom the order is for, the owner's own person for his own purchase`,
      }),
      c("customer_id", "integer", { notnull: true }),
      c("purpose", "text", { notnull: true, note: "personal, business, client, other: why it was ordered" }),
      c("supplier_type", "text", { note: PARTY }),
      c("supplier_id", "integer"),
      c("supplier_name", "text", {
        notnull: true,
        note: "the shop or supplier as its mail names it; an update finds the order by it and the number",
      }),
      c("number", "text", { note: "the shop's order number" }),
      c("currency", "text", { note: "ISO 4217, upper case; set with `total` or not at all" }),
      c("total", "integer", { note: `${MINOR}; null when the mail gives no amount` }),
      c("status", "text", { notnull: true, note: "placed, shipped, delivered, cancelled, returned" }),
      c("order_date", "text", { note: "`YYYY-MM-DD`" }),
      c("fulfilled_date", "text", { note: "`YYYY-MM-DD`: the day it was delivered" }),
      fk("invoice_id", "invoices"),
      fk("payment_id", "payments"),
      fk("project_id", "projects"),
      ...reviewed(),
      ...ts(),
      del(),
      c("source_url", "text", { note: "the http or https page of the order at the shop, such as an Amazon order" }),
      fk("contract_id", "contracts"),
      fk("deal_id", "deals", { note: "the deal it came from, when no contract sits between" }),
      c("direction", "text", {
        notnull: true,
        note: "purchase (the owner buys), sale (the owner sells: he is the supplier)",
      }),
    ],
  },
]
