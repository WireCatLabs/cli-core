import { EVIDENCE_FINDINGS_KIND, type EvidenceFindingsBatch, type MessageStore } from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { kept, proposerOfAuthor, reading } from "./shared.js"

const statusOf = (batch: EvidenceFindingsBatch): ProposalRow["status"] =>
  batch.status === "proposed" ? "proposed" : batch.receipt?.accepted.length ? "confirmed" : "rejected"

const rowOf = (batch: EvidenceFindingsBatch, createdAt: string): ProposalRow => {
  const findings = batch.input.findings
  const outcome = (id: string) => batch.receipt?.items.find((item) => item.id === id)?.status ?? null
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
      summary: finding.kind === "fact" ? finding.statement : finding.title,
      outcome: outcome(finding.id),
    })),
    createdAt,
  }
}

/**
 * An agent's batch of cited facts and tasks from stored messages, mail and documents. Confirming accepts the parts
 * named, or every finding not rejected before; the rest are rejected. Meeting findings stay with their meeting.
 */
export const findingsKind = (store: Pick<MessageStore, "evidenceFindings" | "proposedActions">): ProposalKind => {
  // The batch view carries no staging time; its stored proposal does.
  const created = async (batch: EvidenceFindingsBatch): Promise<ProposalRow> =>
    rowOf(batch, (await store.proposedActions.get(batch.id)).createdAt)
  return {
    kind: "findings",
    stored: [EVIDENCE_FINDINGS_KIND],
    list: async (filter) => {
      const status = filter.status ?? "proposed"
      const batches: EvidenceFindingsBatch[] = []
      for (let offset = 0; batches.length < reading(filter); offset += 50) {
        const page = await store.evidenceFindings.list({
          ...(filter.project === undefined ? {} : { project: filter.project }),
          ...(status === "proposed" ? { status: "proposed" as const } : {}),
          ...(status === "confirmed" || status === "rejected" ? { status: "reviewed" as const } : {}),
          limit: 50,
          offset,
        })
        batches.push(...page.items)
        if (!page.hasMore) break
      }
      return kept(await Promise.all(batches.map(created)), filter)
    },
    get: async (id) => created(await store.evidenceFindings.get(id)),
    decide: async (id, { confirm, by, parts }): Promise<Decided> => {
      const batch = await store.evidenceFindings.get(id)
      const turnedDown = new Set(batch.previous.filter((one) => one.status === "rejected").map((one) => one.id))
      const accept = !confirm
        ? []
        : (parts ?? batch.input.findings.map((finding) => finding.id).filter((one) => !turnedDown.has(one)))
      const reviewed = await store.evidenceFindings.review(id, { fingerprint: batch.fingerprint, accept, by })
      const made = (reviewed.receipt?.items ?? []).flatMap((item) =>
        item.status === "accepted" && item.reference ? [item.reference] : [],
      )
      return { id, kind: "findings", status: accept.length ? "confirmed" : "rejected", made }
    },
  }
}
