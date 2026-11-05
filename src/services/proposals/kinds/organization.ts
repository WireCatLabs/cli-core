import type { Author, MessageStore, Organization, ProposedAction } from "../../../store/index.js"
import { proposerOfAction } from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { actionStatus, kept, pushed, storedStatus } from "./shared.js"

export const ORGANIZATION_ADD_KIND = "organization_add"

export interface OrganizationProposal {
  name: string
  kind: Organization["kind"]
  scope?: Organization["scope"]
}

const rowOf = (action: ProposedAction): ProposalRow => {
  const { name, kind } = action.payload as OrganizationProposal
  return {
    id: action.id,
    kind: "organization",
    status: actionStatus(action.status),
    project: null,
    subject: `organization:new`,
    object: null,
    summary: `add ${kind} ${name}`,
    proposedBy: proposerOfAction(action),
    reason: action.reason,
    evidence: [],
    score: null,
    signals: null,
    parts: null,
    createdAt: action.createdAt,
  }
}

/** An agent's new organization waits as a stored proposal; the organization exists only once it is confirmed. */
export const proposeOrganization = (
  store: Pick<MessageStore, "proposedActions">,
  input: OrganizationProposal,
  by: Author,
): Promise<ProposedAction> => store.proposedActions.propose({ kind: ORGANIZATION_ADD_KIND, by, payload: input })

export const organizationKind = (store: Pick<MessageStore, "proposedActions" | "knowledge">): ProposalKind => ({
  kind: "organization",
  stored: [ORGANIZATION_ADD_KIND],
  list: async (filter) => {
    const status = storedStatus(filter)
    const actions = await store.proposedActions.list({
      kinds: [ORGANIZATION_ADD_KIND],
      ...(status === undefined ? {} : { status }),
      ...pushed(filter),
    })
    return kept(actions.map(rowOf), filter)
  },
  get: async (id) => rowOf(await store.proposedActions.get(id)),
  decide: async (id, { confirm, by, reason }): Promise<Decided> => {
    if (!confirm) {
      await store.proposedActions.reject(id, by, reason)
      return { id, kind: "organization", status: "rejected", made: [] }
    }
    const { name, kind, scope } = (await store.proposedActions.get(id)).payload as OrganizationProposal
    const made = await store.knowledge.addOrganization({ name, kind, ...(scope === undefined ? {} : { scope }) })
    await store.proposedActions.approve(id, by, { organization: made.ref })
    return { id, kind: "organization", status: "confirmed", made: [made.ref] }
  },
})
