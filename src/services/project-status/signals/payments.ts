import { excerpt } from "../items.js"
import type { StatusItem, StatusSignal } from "../types.js"

export interface PaymentsData {
  statement: string
  status: string
}

/** The type the payment slice adds to facts; until it lands, no fact has it and this reads nothing. */
const PAYMENT = "payment"
const HOLDING = new Set(["proposed", "accepted"])

/** Payment facts of the project and its children, proposed or accepted. Only what someone recorded. */
export const payments: StatusSignal<PaymentsData> = {
  id: "payments",
  version: 1,
  scope: "project",
  read: async (context) => {
    const projects = [context.project.ref, ...context.project.children.map((child) => child.ref)]
    const facts = (await Promise.all(projects.map((project) => context.store.facts.list({ project })))).flat()
    return facts
      .filter((fact) => (fact.type as string) === PAYMENT && HOLDING.has(fact.status))
      .map(
        (fact): StatusItem<PaymentsData> => ({
          signal: "payments",
          chat: null,
          at: fact.occurredAt ?? fact.createdAt,
          who: null,
          evidence: [{ ref: fact.ref, fingerprint: null }],
          basis: "fact",
          data: { statement: excerpt(fact.statement), status: fact.status },
        }),
      )
  },
}
