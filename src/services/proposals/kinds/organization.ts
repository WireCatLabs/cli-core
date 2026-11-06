import type { MessageStore, Organization, ProposedAction } from "../../../store/index.js"
import { proposerOfAction } from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { actionStatus, kept, pushed, storedStatus } from "./shared.js"

export const ORGANIZATION_ADD_KIND = "organization_add"
export const ORGANIZATION_RENAME_KIND = "organization_rename"

export interface OrganizationProposal {
  name: string
  kind: Organization["kind"]
  scope?: Organization["scope"]
}

export interface OrganizationRenameProposal {
  organization: string
  name: string
}

const rowOf = (action: ProposedAction): ProposalRow => {
  const renamed = action.kind === ORGANIZATION_RENAME_KIND
  const { name, kind } = action.payload as OrganizationProposal
  const { organization } = action.payload as OrganizationRenameProposal
  return {
    id: action.id,
    kind: "organization",
    status: actionStatus(action.status),
    project: null,
    subject: renamed ? organization : "organization:new",
    object: null,
    summary: renamed ? `rename ${organization} to ${name}` : `add ${kind} ${name}`,
    proposedBy: proposerOfAction(action),
    reason: action.reason,
    evidence: [],
    score: null,
    signals: null,
    parts: null,
    createdAt: action.createdAt,
  }
}

/** Only rows stored before agents wrote organizations at once; they stay decidable in review. */
export const organizationKind = (store: Pick<MessageStore, "proposedActions" | "knowledge">): ProposalKind => ({
  kind: "organization",
  stored: [ORGANIZATION_ADD_KIND, ORGANIZATION_RENAME_KIND],
  list: async (filter) => {
    const status = storedStatus(filter)
    const actions = await store.proposedActions.list({
      kinds: [ORGANIZATION_ADD_KIND, ORGANIZATION_RENAME_KIND],
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
    const action = await store.proposedActions.get(id)
    if (action.kind === ORGANIZATION_RENAME_KIND) {
      const { organization, name } = action.payload as OrganizationRenameProposal
      const renamed = await store.knowledge.updateOrganization(organization, { name })
      await store.proposedActions.approve(id, by, { organization: renamed.ref })
      return { id, kind: "organization", status: "confirmed", made: [] }
    }
    const { name, kind, scope } = action.payload as OrganizationProposal
    const made = await store.knowledge.addOrganization({ name, kind, ...(scope === undefined ? {} : { scope }) })
    await store.proposedActions.approve(id, by, { organization: made.ref })
    return { id, kind: "organization", status: "confirmed", made: [made.ref] }
  },
})
