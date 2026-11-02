import type { Payment } from "../../../meetings/index.js"
import type { FinancePayment, Invoice } from "../../../store/index.js"
import type { StatusItem, StatusSignal } from "../types.js"

export interface PaymentsData extends Payment {
  title: string
  /** The row's review: proposed or confirmed. */
  status: string
}

const holding = (row: { review: string }) => row.review !== "rejected"

const item = (row: FinancePayment | Invoice, at: string, data: Payment): StatusItem<PaymentsData> => ({
  signal: "payments",
  chat: null,
  at,
  who: null,
  // The row first, then what it cites, so an amount read from a cited message is not counted twice.
  evidence: [row.ref, ...row.evidence].map((ref) => ({ ref, fingerprint: null })),
  basis: "store",
  data: { ...data, title: row.title, status: row.review },
})

const paid = (row: FinancePayment): StatusItem<PaymentsData> => {
  const party = row.direction === "in" ? row.payer : row.payee
  return item(row, `${row.date}T00:00:00.000Z`, {
    amount: row.amount,
    currency: row.currency,
    direction: row.direction === "in" ? "to_us" : "from_us",
    counterparty: party?.ref ?? null,
    counterparty_name: party?.name ?? null,
    due_at: null,
    state: "paid",
    item: row.reference,
    paid_at: row.date,
  })
}

/** What an open invoice still owes is the expected payment. */
const expected = (row: Invoice): StatusItem<PaymentsData> =>
  item(row, row.issueDate === null ? row.createdAt : `${row.issueDate}T00:00:00.000Z`, {
    amount: row.open,
    currency: row.currency,
    direction: row.direction === "receivable" ? "to_us" : "from_us",
    counterparty: row.counterparty.ref,
    counterparty_name: row.counterparty.name,
    due_at: row.dueDate,
    state: "expected",
    item: row.number,
  })

/** Payments and open invoices of the project and its children from `store.finance`, proposed or confirmed. */
export const payments: StatusSignal<PaymentsData> = {
  id: "payments",
  version: 3,
  scope: "project",
  read: async (context) => {
    const projects = [context.project.ref, ...context.project.children.map((child) => child.ref)]
    const rows = await Promise.all(
      projects.map(async (project) => [
        ...(await context.store.finance.payments({ project, limit: 500 })).filter(holding).map(paid),
        ...(await context.store.finance.invoices({ project, open: true, limit: 500 })).filter(holding).map(expected),
      ]),
    )
    return rows.flat()
  },
}
