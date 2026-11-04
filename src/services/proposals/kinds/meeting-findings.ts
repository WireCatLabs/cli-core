import { CliError } from "@wirecat/cli-base"
import { MEETING_FINDINGS_KIND } from "../../../meetings/index.js"
import {
  type MeetingFindingsBatch,
  type MessageStore,
  type ProposedAction,
  proposerOfAction,
} from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { FACT_SUMMARIES } from "./findings.js"
import { kept } from "./shared.js"

const rowOf = (action: ProposedAction, batch: MeetingFindingsBatch): ProposalRow => {
  const findings = batch.input.findings
  const projects = [...new Set(findings.map((one) => ("project" in one ? one.project : undefined)))]
  const outcome = (id: string) => batch.receipt?.items.find((item) => item.id === id)?.status ?? null
  const references = [...new Set(findings.flatMap((finding) => finding.evidence.map((one) => one.reference)))]
  return {
    id: action.id,
    kind: "meeting_findings",
    status: batch.status === "proposed" ? "proposed" : batch.receipt?.accepted.length ? "confirmed" : "rejected",
    project: projects.length === 1 && typeof projects[0] === "string" ? projects[0] : null,
    subject: references[0] ?? `meeting_findings:${action.id}`,
    object: null,
    summary: `${findings.length} finding${findings.length === 1 ? "" : "s"}`,
    proposedBy: proposerOfAction(action),
    reason: action.reason,
    evidence: references.slice(0, 5),
    score: null,
    signals: null,
    parts: findings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      summary: FACT_SUMMARIES[finding.kind]?.(finding) ?? finding.kind,
      outcome: outcome(finding.id),
    })),
    createdAt: action.createdAt,
  }
}

/**
 * A meeting's cited findings, staged by `meetings actions add`: the same review as `meetings actions confirm`, with
 * the batch's current fingerprint. Only the owner decides it.
 */
export const meetingFindingsKind = (store: Pick<MessageStore, "meetingFindings" | "proposedActions">): ProposalKind => {
  const batchOf = async (action: ProposedAction) => {
    if (action.account === null) throw new CliError("not_found", `meeting findings ${action.id} name no account`)
    return { account: action.account, batch: await store.meetingFindings.get(action.account, action.id) }
  }
  return {
    kind: "meeting_findings",
    stored: [MEETING_FINDINGS_KIND],
    parts: true,
    ownerOnly: true,
    list: async (filter) => {
      const actions = await store.proposedActions.list({
        kinds: [MEETING_FINDINGS_KIND],
        ...((filter.status ?? "proposed") === "proposed" ? { status: "proposed" as const } : {}),
        ...(filter.by === undefined ? {} : { proposedBy: filter.by }),
        limit: Math.min(filter.offset + filter.limit, 500),
      })
      const rows = await Promise.all(actions.map(async (action) => rowOf(action, (await batchOf(action)).batch)))
      return kept(rows, { ...filter, limit: filter.offset + filter.limit })
    },
    get: async (id) => {
      const action = await store.proposedActions.get(id)
      return rowOf(action, (await batchOf(action)).batch)
    },
    decide: async (id, { confirm, by, parts }): Promise<Decided> => {
      const { account, batch } = await batchOf(await store.proposedActions.get(id))
      const turnedDown = new Set(batch.previous.filter((one) => one.status === "rejected").map((one) => one.id))
      const accept = !confirm
        ? []
        : (parts ?? batch.input.findings.map((finding) => finding.id).filter((one) => !turnedDown.has(one)))
      const reviewed = await store.meetingFindings.review(account, id, { fingerprint: batch.fingerprint, accept, by })
      const made = (reviewed.receipt?.items ?? []).flatMap((item) =>
        item.status === "accepted" && item.reference && !item.reused ? [item.reference] : [],
      )
      return { id, kind: "meeting_findings", status: accept.length ? "confirmed" : "rejected", made }
    },
  }
}
