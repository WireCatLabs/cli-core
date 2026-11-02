import type { MailFinding } from "../../../mail/findings.js"
import { MAIL_FINDINGS_KIND, type MailFindingsBatch, type MessageStore } from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { kept, proposerOfAuthor } from "./shared.js"

/** A finding's one line in the inbox; never the email's text, only what the agent wrote. */
const summaryOf = (finding: MailFinding): string => {
  switch (finding.kind) {
    case "task":
      return finding.title
    case "fact":
      return finding.statement
    case "task_update":
      return `${finding.change} ${finding.task}: ${finding.reason}`
    case "memory":
      return finding.body.slice(0, 200)
    case "link":
      return `${finding.from} → ${finding.to}`
    case "new_contact":
      return `${finding.name} <${finding.address}>`
  }
}

const rowOf = (batch: MailFindingsBatch, createdAt: string): ProposalRow => {
  const findings = batch.input.findings
  const outcome = (id: string) => batch.receipt?.items.find((item) => item.id === id)?.status ?? null
  const project =
    findings.flatMap((finding) => ("project" in finding && finding.project ? [finding.project] : []))[0] ?? null
  return {
    id: batch.id,
    kind: "mail_findings",
    status: batch.status === "proposed" ? "proposed" : batch.receipt?.accepted.length ? "confirmed" : "rejected",
    project,
    subject: `findings:${batch.id}`,
    object: null,
    summary: `${findings.length} mail finding${findings.length === 1 ? "" : "s"} for ${batch.account.account}`,
    proposedBy: proposerOfAuthor(batch.author),
    reason: null,
    evidence: [...new Set(findings.flatMap((finding) => finding.evidence.map((one) => one.reference)))].slice(0, 5),
    score: null,
    signals: null,
    parts: findings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      summary: summaryOf(finding),
      outcome: outcome(finding.id),
    })),
    createdAt,
  }
}

/**
 * What an agent read in new mail, one batch per mailbox and run. Only the owner decides it (NEED-2187): an agent's
 * confirmation is refused whatever `agent_decisions` says. Confirming accepts the parts named, or every finding not
 * rejected before; the rest are rejected.
 */
export const mailFindingsKind = (store: Pick<MessageStore, "mailFindings" | "proposedActions">): ProposalKind => {
  const created = async (batch: MailFindingsBatch): Promise<ProposalRow> =>
    rowOf(batch, (await store.proposedActions.get(batch.id)).createdAt)
  return {
    kind: "mail_findings",
    stored: [MAIL_FINDINGS_KIND],
    parts: true,
    ownerOnly: true,
    list: async (filter) => {
      const status = filter.status ?? "proposed"
      const rows: ProposalRow[] = []
      for (let offset = 0; rows.length < filter.limit; offset += 50) {
        const page = await store.mailFindings.list({
          ...(status === "proposed" ? { status: "proposed" as const } : {}),
          ...(status === "confirmed" || status === "rejected" ? { status: "reviewed" as const } : {}),
          limit: 50,
          offset,
        })
        for (const row of kept(await Promise.all(page.items.map(created)), { ...filter, limit: 50 })) rows.push(row)
        if (!page.hasMore) break
      }
      return kept(rows, filter)
    },
    get: async (id) => created(await store.mailFindings.get(id)),
    decide: async (id, { confirm, by, parts }): Promise<Decided> => {
      const batch = await store.mailFindings.get(id)
      const turnedDown = new Set(batch.previous.filter((one) => one.status === "rejected").map((one) => one.id))
      const accept = !confirm
        ? []
        : (parts ?? batch.input.findings.map((finding) => finding.id).filter((one) => !turnedDown.has(one)))
      const reviewed = await store.mailFindings.review(id, { fingerprint: batch.fingerprint, accept, by })
      const made = (reviewed.receipt?.items ?? []).flatMap((item) =>
        item.status === "accepted" && item.reference && !item.reused ? [item.reference] : [],
      )
      return { id, kind: "mail_findings", status: accept.length ? "confirmed" : "rejected", made }
    },
  }
}
