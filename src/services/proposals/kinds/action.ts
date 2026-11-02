import { MEETING_FINDINGS_KIND } from "../../../meetings/index.js"
import { type MessageStore, type ProposedAction, proposerOfAction } from "../../../store/index.js"
import { approveAsTask } from "../../proposal-tasks.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { actionStatus, kept, projectOf, reading, storedStatus } from "./shared.js"

const rowOf = (action: ProposedAction): ProposalRow => ({
  id: action.id,
  kind: "action",
  status: actionStatus(action.status),
  project: projectOf(action.target),
  subject: action.target ?? `action:${action.id}`,
  object: null,
  summary: action.kind,
  proposedBy: proposerOfAction(action),
  reason: action.reason,
  evidence: [],
  score: null,
  signals: null,
  parts: null,
  createdAt: action.createdAt,
})

/**
 * Every stored proposal no other kind claims: a reply, a ban, a task to create. Confirming makes it the owner's task
 * in the account that would act; nothing is carried out. Meeting findings are reviewed with their meeting.
 */
export const actionKind = (
  store: Pick<MessageStore, "proposedActions" | "tasks">,
  claimed: () => readonly string[],
): ProposalKind => ({
  kind: "action",
  list: async (filter) => {
    const status = storedStatus(filter)
    const actions = await store.proposedActions.list({
      except: [...claimed(), MEETING_FINDINGS_KIND],
      ...(status === undefined ? {} : { status }),
      limit: reading(filter),
    })
    return kept(actions.map(rowOf), filter)
  },
  get: async (id) => rowOf(await store.proposedActions.get(id)),
  decide: async (id, { confirm, by }): Promise<Decided> => {
    if (!confirm) {
      await store.proposedActions.reject(id, by)
      return { id, kind: "action", status: "rejected", made: [] }
    }
    const { task } = await approveAsTask(store, id, by)
    return { id, kind: "action", status: "confirmed", made: [`task:${task.key ?? task.id}`] }
  },
})
