import { CliError } from "@wirecat/cli-base"
import { contextEvidenceFingerprint } from "../../context/evidence.js"
import {
  type FindingEvidence,
  type FindingOutcome,
  type FindingsInput,
  findingFingerprint,
  findingHash,
} from "../../meetings/index.js"
import { assertMayDecide } from "../decisions.js"
import {
  EVIDENCE_FINDINGS_KIND,
  type EvidenceFindingsBatch,
  type EvidenceFindingsReceipt,
  type EvidenceFindingsStore,
  validateEvidenceFindings,
} from "../evidence-findings.js"
import { contextRecordOf } from "./context-evidence.js"
import { quoteKept } from "./evidence-signature.js"
import { sourcesOfReferences } from "./evidence-sources.js"
import {
  editedFinding,
  FINDING_EDITS,
  findingsAgent,
  findingsCoreOver,
  findingToEdit,
  pendingOf,
} from "./findings-core.js"
import { authorActor } from "./memories.js"
import type { StoreContext } from "./open.js"
import { type ProposedAction, proposalOperationsOver } from "./proposed-actions.js"
import { write } from "./transaction.js"

type StoredInput = FindingsInput & {
  inputHash: string
  snapshotHash: string
  snapshotParts?: Record<string, string>
  agentModel: string | null
  ownerOnly?: true
  decided?: FindingOutcome[]
  accepted?: string[]
  edited?: string[]
}
const stale = (): never => {
  throw new CliError("validation_error", "evidence findings changed since they were read; stage a new batch", {
    reason: "evidence-findings.stale",
  })
}
const invalid = (message: string): never => {
  throw new CliError("validation_error", message)
}
const TEXT_BUDGET = 262144

export const evidenceFindingsStoreOver = (context: StoreContext): EvidenceFindingsStore => {
  const { database } = context
  const proposals = proposalOperationsOver(context)
  const core = findingsCoreOver(context, EVIDENCE_FINDINGS_KIND)
  const load = (id: string): ProposedAction => {
    if (typeof id !== "string" || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
      return invalid("a findings batch needs a stored ID")
    const row = database
      .prepare(
        "SELECT length(CAST(payload AS BLOB)) AS bytes,length(CAST(result AS BLOB)) AS result_bytes FROM proposed_actions WHERE id=? AND account_id IS NULL AND kind=?",
      )
      .get(Number(id), EVIDENCE_FINDINGS_KIND)
    if (!row) throw new CliError("not_found", "the evidence findings batch is unavailable")
    if (Number(row.bytes) > 100000 || Number(row.result_bytes) > 65536)
      return invalid("stored findings exceed the read budget")
    return proposals.get(id)
  }
  /** The one project its findings name, or `null` when none does. */
  const projectOf = (input: FindingsInput) => input.findings.find((finding) => finding.project)?.project ?? null
  const view = (proposal: ProposedAction): EvidenceFindingsBatch => {
    const input = proposal.payload as StoredInput
    if (!input || !["proposed", "approved", "rejected"].includes(proposal.status))
      return invalid("invalid stored findings batch")
    return {
      id: proposal.id,
      project: projectOf(input),
      subject: proposal.target,
      input: { schemaVersion: 1, key: input.key, extractor: input.extractor, findings: input.findings },
      fingerprint: findingHash({ input, author: proposal.proposedBy.id }),
      status: proposal.status === "proposed" ? "proposed" : "reviewed",
      ownerOnly: input.ownerOnly === true || input.findings.some((finding) => finding.kind === "payment"),
      author: proposal.proposedBy,
      decidedBy: proposal.decidedBy,
      decidedAt: proposal.decidedAt,
      previous: proposal.result
        ? (proposal.result as EvidenceFindingsReceipt).items
        : pendingOf(input, input.decided).findings.flatMap((finding) => {
            const held = core.previous(null, findingFingerprint(finding), proposal.id)
            return held ? [{ ...held, id: finding.id, reused: true }] : []
          }),
      decided: proposal.result ? [] : (input.decided ?? []),
      edited: input.edited ?? [],
      receipt: proposal.result as EvidenceFindingsReceipt | null,
    }
  }
  const cite = () => {
    let readBytes = 0
    const texts = new Map<string, string>()
    const quoted = (evidence: FindingEvidence) => {
      if (evidence.quote !== undefined && !quoteKept(evidence.quote, texts.get(evidence.reference) ?? ""))
        throw new CliError("validation_error", `the quote cited from ${evidence.reference} is not in its text`, {
          reason: "finding.quote-not-found",
        })
    }
    return (evidence: FindingEvidence, _finding: unknown, _project: unknown, seen: Map<string, unknown>) => {
      if (seen.has(evidence.reference)) {
        if (seen.get(evidence.reference) !== evidence.fingerprint) return stale()
        return quoted(evidence)
      }
      const record = contextRecordOf(database, evidence.reference)
      if (!record) return stale()
      readBytes += Buffer.byteLength(record.text) + Buffer.byteLength(record.title ?? "")
      if (readBytes > TEXT_BUDGET) return invalid(`finding evidence exceeds the ${TEXT_BUDGET}-byte stored text budget`)
      const fingerprint = contextEvidenceFingerprint(record)
      if (fingerprint !== evidence.fingerprint) return stale()
      seen.set(evidence.reference, fingerprint)
      texts.set(evidence.reference, record.text)
      quoted(evidence)
    }
  }
  const snapshot = (input: FindingsInput) => core.snapshot(input, cite())
  /**
   * The whole-batch hash the next review of an old batch compares, over the findings still waiting. Evidence that
   * changed under a waiting finding keeps the old hash, so accepting that finding stays refused as stale.
   */
  const snapshotOr = (waiting: FindingsInput, held: string): string => {
    try {
      return snapshot(waiting)
    } catch (error) {
      if ((error as CliError).details?.reason === "evidence-findings.stale") return held
      throw error
    }
  }
  const decider = (by: unknown) => {
    if (by === "owner") return { author: "owner" as const, decision: { by: "owner" as const } }
    if (by === undefined) return invalid("a findings review names who decides: the owner or an agent with a reason")
    const raw = by as { bot?: unknown; model?: unknown; reason?: unknown }
    const agent = findingsAgent({
      bot: raw.bot as string,
      ...(raw.model === undefined ? {} : { model: raw.model as string }),
    })
    if (typeof raw.reason !== "string" || !raw.reason.trim() || raw.reason.length > 2000)
      return invalid("an agent deciding for the owner gives a reason of 1–2000 characters")
    return {
      author: agent,
      decision: { by: "agent" as const, bot: agent.bot, model: agent.model ?? null, reason: raw.reason.trim() },
    }
  }
  return {
    stage: async (raw, rawAgent, { ownerOnly = false } = {}) => {
      const input = validateEvidenceFindings(raw)
      const projects = new Set(input.findings.flatMap((finding) => finding.project ?? []))
      if (projects.size > 1) return invalid("an evidence findings batch is about one project at most")
      const subjects = new Set(input.findings.map((finding) => finding.subject))
      const shared = subjects.size === 1 ? [...subjects][0] : undefined
      const target = shared ?? [...projects][0]
      const by = findingsAgent(rawAgent)
      return write(database, () => {
        const { actor } = authorActor(context, by)
        const inputHash = findingHash({ input, model: by.model ?? null, ...(ownerOnly ? { ownerOnly } : {}) })
        const held = database
          .prepare(
            "SELECT id FROM proposed_actions WHERE account_id IS NULL AND kind=? AND proposed_by_type=? AND proposed_by_id=? AND json_extract(payload,'$.key')=? ORDER BY id LIMIT 1",
          )
          .get(EVIDENCE_FINDINGS_KIND, actor.type, actor.id, input.key)
        if (held) {
          const proposal = load(String(held.id))
          if ((proposal.payload as StoredInput).inputHash !== inputHash)
            return invalid("the findings batch key was already used for different input")
          return view(proposal)
        }
        const snapshotHash = snapshot(input)
        const snapshotParts = core.snapshotParts(input, cite())
        const fingerprints = input.findings.map(findingFingerprint)
        if (new Set(fingerprints).size !== fingerprints.length) return invalid("the batch contains duplicate findings")
        return view(
          proposals.propose({
            kind: EVIDENCE_FINDINGS_KIND,
            by,
            ...(target === undefined ? {} : { target }),
            payload: {
              ...input,
              inputHash,
              snapshotHash,
              snapshotParts,
              agentModel: by.model ?? null,
              ...(ownerOnly ? { ownerOnly: true } : {}),
            },
          }),
        )
      })
    },
    get: async (id) => view(load(id)),
    citable: async (reference) => {
      const record = contextRecordOf(database, reference)
      return record
        ? { reference, fingerprint: contextEvidenceFingerprint(record), title: record.title, text: record.text }
        : null
    },
    sources: async (id) =>
      sourcesOfReferences(
        database,
        view(load(id)).input.findings.flatMap((finding) => finding.evidence.map((one) => one.reference)),
      ),
    list: async ({ project, limit = 20, offset = 0, status } = {}) => {
      if (status !== undefined && status !== "proposed" && status !== "reviewed")
        return invalid("finding status is proposed or reviewed")
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0)
        return invalid("findings lists take 1–50 items and a nonnegative offset")
      const projectId = project === undefined ? null : /^project:([1-9]\d*)$/.exec(project)?.[1]
      if (projectId === undefined) return invalid("a findings list filters by a project reference")
      const ids = database
        .prepare(
          "SELECT id FROM proposed_actions WHERE account_id IS NULL AND kind=? AND (? IS NULL OR (target_type='project' AND target_id=?) " +
            "OR EXISTS (SELECT 1 FROM json_each(payload,'$.findings') f WHERE json_extract(f.value,'$.project')=?)) " +
            "AND (? IS NULL OR status=?) ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .all(
          EVIDENCE_FINDINGS_KIND,
          projectId,
          projectId === null ? null : Number(projectId),
          projectId === null ? null : `project:${projectId}`,
          status ?? null,
          status === "reviewed" ? "approved" : (status ?? null),
          limit + 1,
          offset,
        )
      return { items: ids.slice(0, limit).map((row) => view(load(String(row.id)))), hasMore: ids.length > limit }
    },
    review: async (id, decision) =>
      write(database, () => {
        const proposal = load(id)
        const batch = view(proposal)
        if (!decision || typeof decision.fingerprint !== "string" || decision.fingerprint !== batch.fingerprint)
          return stale()
        if (
          !Array.isArray(decision.accept) ||
          decision.accept.length > 16 ||
          new Set(decision.accept).size !== decision.accept.length ||
          decision.accept.some((candidate) => !batch.input.findings.some((finding) => finding.id === candidate))
        )
          return invalid("accept only unique IDs shown in this batch")
        const accepted = [...decision.accept].sort()
        const { author, decision: checked } = decider(decision.by)
        const reason = typeof decision.reason === "string" ? decision.reason.trim().slice(0, 2000) : ""
        const decidedBy =
          reason && checked.by === "owner"
            ? { ...checked, reason }
            : reason && checked.by === "agent"
              ? { ...checked, reason: `${checked.reason}: ${reason}` }
              : checked
        assertMayDecide(
          {
            id,
            proposedBy: proposals.proposer(id),
            ownerOnly: batch.ownerOnly,
          },
          decision.by,
          context.decisions,
        )
        if (batch.receipt) {
          if (!core.sameDecision(batch.receipt, accepted))
            return invalid("this findings batch was already reviewed with a different decision")
          return batch
        }
        const input = proposal.payload as StoredInput
        const waiting = pendingOf(batch.input, input.decided)
        // Rejecting creates nothing, so a batch whose evidence changed can still be closed. Accepting needs only the
        // accepted findings' own evidence and assignee unchanged. The project is left out: every task a sibling batch
        // creates moves its row, and the project still has to exist, which citing checks. A batch staged before parts
        // were kept needs all.
        if (accepted.length) {
          const parts = input.snapshotParts
          if (!parts) {
            if (snapshot(waiting) !== input.snapshotHash) return stale()
          } else {
            const chosen = { ...batch.input, findings: waiting.findings.filter((f) => accepted.includes(f.id)) }
            const now = core.snapshotParts(chosen, cite())
            if (Object.entries(now).some(([key, hash]) => !key.startsWith("project:") && parts[key] !== hash))
              return stale()
          }
        }
        if (proposal.proposedBy.type !== "bot" || !proposal.proposedBy.name)
          return invalid("a findings author must be an agent")
        const agent = {
          bot: proposal.proposedBy.name,
          ...(input.agentModel === null ? {} : { model: input.agentModel }),
        }
        const by = decision.by
        const { items, pending } = core.settle({
          batch: id,
          account: null,
          findings: batch.input.findings,
          decided: input.decided ?? [],
          accepted,
          fingerprintOf: findingFingerprint,
          make: (finding) => core.create(finding, agent, by),
        })
        const named = core.named(input.accepted, accepted)
        if (pending.length) {
          core.keepWaiting(id, {
            ...input,
            decided: items,
            accepted: named,
            snapshotHash: snapshotOr({ ...batch.input, findings: pending }, input.snapshotHash),
          })
          return view(load(id))
        }
        return view(
          proposals.approve(
            id,
            {
              previewFingerprint: batch.fingerprint,
              accepted: named,
              items,
              decision: decidedBy,
            } satisfies EvidenceFindingsReceipt,
            author,
          ),
        )
      }),
    edit: async (id, finding, changes, options) =>
      write(database, () => {
        const proposal = load(id)
        const batch = view(proposal)
        const original = findingToEdit(batch, finding, options, stale)
        const input = proposal.payload as StoredInput
        const parts = input.snapshotParts
        const alone = (one: FindingsInput["findings"][number]) => ({ ...batch.input, findings: [one] })
        if (parts) {
          const now = core.snapshotParts(alone(original), cite())
          if (Object.entries(now).some(([key, hash]) => !key.startsWith("project:") && parts[key] !== hash))
            return stale()
        } else if (snapshot(pendingOf(batch.input, input.decided)) !== input.snapshotHash) return stale()
        const edited = editedFinding(original, changes, FINDING_EDITS, "evidence finding")
        const checked = validateEvidenceFindings({
          ...batch.input,
          findings: batch.input.findings.map((one) => (one.id === finding ? edited : one)),
        })
        const fingerprints = checked.findings.map(findingFingerprint)
        if (new Set(fingerprints).size !== fingerprints.length) return invalid("the edit makes two findings the same")
        // The agent's inputHash stays: its rerun of the same key still finds this batch, now as the owner left it.
        const now = checked.findings.find((one) => one.id === finding) as FindingsInput["findings"][number]
        core.keepWaiting(id, {
          ...input,
          findings: checked.findings,
          snapshotHash: snapshotOr(pendingOf(checked, input.decided), input.snapshotHash),
          ...(parts ? { snapshotParts: { ...parts, ...core.snapshotParts(alone(now), cite()) } } : {}),
          edited: [...new Set([...(input.edited ?? []), finding])],
        })
        return view(load(id))
      }),
  }
}
