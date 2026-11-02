import { type Payment, paymentTitle } from "../../../meetings/index.js"
import type { StatusItem, StatusSignal } from "../types.js"

export interface PaymentsData extends Payment {
  title: string
  /** The fact's review status: proposed or accepted. */
  status: string
}

const HOLDING = new Set(["proposed", "accepted"])

/** Payment facts of the project and its children, proposed or accepted. Only what someone recorded. */
export const payments: StatusSignal<PaymentsData> = {
  id: "payments",
  version: 2,
  scope: "project",
  read: async (context) => {
    const projects = [context.project.ref, ...context.project.children.map((child) => child.ref)]
    const facts = (
      await Promise.all(projects.map((project) => context.store.facts.list({ project, type: "payment", limit: 500 })))
    ).flat()
    return facts
      .filter((fact) => fact.payment !== null && HOLDING.has(fact.status))
      .map(
        (fact): StatusItem<PaymentsData> => ({
          signal: "payments",
          chat: null,
          at: fact.occurredAt ?? fact.createdAt,
          who: null,
          // The fact first, then what it cites, so an amount read from a cited message is not counted twice.
          evidence: [fact.ref, ...fact.evidence].map((ref) => ({ ref, fingerprint: null })),
          basis: "fact",
          data: { ...(fact.payment as Payment), title: paymentTitle(fact), status: fact.status },
        }),
      )
  },
}
