import type { Finding } from "../../../meetings/index.js"
import { paymentTitle } from "../../../meetings/index.js"
import { EVIDENCE_FINDINGS_KIND, type EvidenceFindingsBatch, type MessageStore } from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { kept, proposerOfAuthor } from "./shared.js"

/** A finding's one line in the inbox, per kind; a new fact kind adds its row here. */
export const FACT_SUMMARIES: Record<string, (finding: Finding) => string> = {
  fact: (finding) => (finding as Extract<Finding, { kind: "fact" }>).statement,
  task: (finding) => (finding as Extract<Finding, { kind: "task" }>).title,
  payment: (finding) => paymentTitle(finding as Extract<Finding, { kind: "payment" }>),
}

const statusOf = (batch: EvidenceFindingsBatch): ProposalRow["status"] =>
  batch.status === "proposed" ? "proposed" : batch.receipt?.accepted.length ? "confirmed" : "rejected"

const rowOf = (batch: EvidenceFindingsBatch, createdAt: string): ProposalRow => {
  const findings = batch.input.findings
  const outcome = (id: string) => (batch.receipt?.items ?? batch.decided).find((item) => item.id === id)?.status ?? null
  return {
    id: batch.id,
    kind: "findings",
    status: statusOf(batch),
    project: batch.project,
    subject: batch.subject ?? batch.project ?? `findings:${batch.id}`,
    object: null,
    summary: `${findings.length} finding${findings.length === 1 ? "" : "s"}`,
    proposedBy: proposerOfAuthor(batch.author),
    reason: null,
    evidence: [...new Set(findings.flatMap((finding) => finding.evidence.map((one) => one.reference)))].slice(0, 5),
    score: null,
    signals: null,
    parts: findings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      summary: FACT_SUMMARIES[finding.kind]?.(finding) ?? finding.kind,
      outcome: outcome(finding.id),
    })),
    createdAt,
  }
}

/**
 * An agent's batch of cited facts and tasks from stored messages, mail and documents. Confirming accepts the parts
 * named, or every finding not rejected before; the rest wait. Rejecting turns down what still waits. Meeting findings
 * have their own kind.
 */
export const findingsKind = (store: Pick<MessageStore, "evidenceFindings" | "proposedActions">): ProposalKind => {
  // The batch view carries no staging time; its stored proposal does.
  const created = async (batch: EvidenceFindingsBatch): Promise<ProposalRow> =>
    rowOf(batch, (await store.proposedActions.get(batch.id)).createdAt)
  return {
    kind: "findings",
    stored: [EVIDENCE_FINDINGS_KIND],
    parts: true,
    list: async (filter) => {
      const status = filter.status ?? "proposed"
      const rows: ProposalRow[] = []
      // The findings list filters by project and status only; a proposer filter is applied page by page until full.
      for (let offset = 0; rows.length < filter.limit; offset += 50) {
        const page = await store.evidenceFindings.list({
          ...(filter.project === undefined ? {} : { project: filter.project }),
          ...(status === "proposed" ? { status: "proposed" as const } : {}),
          ...(status === "confirmed" || status === "rejected" ? { status: "reviewed" as const } : {}),
          limit: 50,
          offset,
        })
        rows.push(...kept(await Promise.all(page.items.map(created)), { ...filter, limit: 50 }).items)
        if (!page.hasMore) break
      }
      return kept(rows, filter)
    },
    get: async (id) => created(await store.evidenceFindings.get(id)),
    decide: async (id, { confirm, by, parts, reason }): Promise<Decided> => {
      const batch = await store.evidenceFindings.get(id)
      // A finding this batch already decided keeps its outcome; a confirm with no names takes what still waits.
      const turnedDown = new Set([
        ...batch.previous.filter((one) => one.status === "rejected").map((one) => one.id),
        ...batch.decided.map((one) => one.id),
      ])
      const accept = !confirm
        ? []
        : (parts ?? batch.input.findings.map((finding) => finding.id).filter((one) => !turnedDown.has(one)))
      const reviewed = await store.evidenceFindings.review(id, {
        fingerprint: batch.fingerprint,
        accept,
        by,
        ...(reason === undefined ? {} : { reason }),
      })
      const made = (reviewed.receipt?.items ?? reviewed.decided).flatMap((item) =>
        item.status === "accepted" && item.reference && !item.reused && accept.includes(item.id)
          ? [item.reference]
          : [],
      )
      return { id, kind: "findings", status: accept.length ? "confirmed" : "rejected", made }
    },
  }
}
