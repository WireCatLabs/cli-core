import { CliError } from "@wirecat/cli-base"
import { formatLocator, parseLocator } from "../domain/locator.js"
import { type FindingOutcome, type FindingsInput, type FindingsReceipt, validateFindings } from "../meetings/index.js"
import type { Decider } from "./decisions.js"
import { QUOTE_LIMIT } from "./sqlite/evidence-signature.js"
import type { EvidenceSource } from "./sqlite/evidence-sources.js"
import { entryAmount } from "./sqlite/payment-entries.js"

export const EVIDENCE_FINDINGS_KIND = "evidence_findings"

const reference = (raw: string) => {
  if (/^(document|note):[1-9]\d*$/.test(raw)) return raw
  try {
    return formatLocator(parseLocator(raw))
  } catch {
    throw new CliError("validation_error", "finding evidence is a msg:, document: or note: reference")
  }
}
export const validateEvidenceFindings = (input: FindingsInput): FindingsInput => {
  const valid = validateFindings(input, {
    plural: "evidence findings",
    singular: "evidence finding",
    cited: "reference",
    reference,
    anySubject: true,
    payments: true,
    quotes: QUOTE_LIMIT,
  })
  // Refused at staging rather than when the owner accepts, which would fail the whole batch.
  for (const finding of valid.findings) if (finding.kind === "payment") entryAmount(finding.payment)
  return valid
}

/** Who decided: the owner, or an agent the host let decide for the owner, with its reason. */
export type EvidenceFindingsDecider = Decider

export interface EvidenceFindingsReceipt extends FindingsReceipt {
  decision: { by: "owner"; reason?: string } | { by: "agent"; bot: string; model: string | null; reason: string }
}
export interface EvidenceFindingsBatch {
  id: string
  /** `null` when its findings name no one project. */
  project: string | null
  /** Who or what every finding is about, when they agree: a project, person, organization or task; else `null`. */
  subject: string | null
  input: FindingsInput
  fingerprint: string
  status: "proposed" | "reviewed"
  /** Only the owner decides it, whatever `agent_decisions` says: it was staged so, or it records a payment. */
  ownerOnly: boolean
  author: { type: "person" | "bot"; id: string; name: string | null; kind: "agent" | "rule" | null }
  decidedBy: { type: "person" | "bot"; id: string } | null
  decidedAt: string | null
  previous: FindingOutcome[]
  /** What a review of this still waiting batch already decided; the other findings wait for the owner. */
  decided: FindingOutcome[]
  /** The findings the owner changed before deciding them. */
  edited: string[]
  receipt: EvidenceFindingsReceipt | null
}
/**
 * Cited facts and follow-ups about one project from stored messages, mail and documents, staged by an agent for
 * review. A sibling of meeting findings: the same rules, evidence checked against the current stored text.
 */
/** A stored record as a findings batch cites it: the text a quote must be in, and the fingerprint staging checks. */
export interface CitableRecord {
  reference: string
  fingerprint: string
  title: string | null
  text: string
}
export interface EvidenceFindingsStore {
  /** `ownerOnly` keeps every agent from deciding the batch, whatever `agent_decisions` says. */
  stage(
    input: FindingsInput,
    agent: { bot: string; model?: string },
    options?: { ownerOnly?: boolean },
  ): Promise<EvidenceFindingsBatch>
  /** A `msg:`, `document:` or `note:` record as staging reads it; `null` when it is not stored. */
  citable(reference: string): Promise<CitableRecord | null>
  get(id: string): Promise<EvidenceFindingsBatch>
  list(options?: {
    project?: string
    limit?: number
    offset?: number
    status?: "proposed" | "reviewed"
  }): Promise<{ items: EvidenceFindingsBatch[]; hasMore: boolean }>
  review(
    id: string,
    input: { fingerprint: string; accept: string[]; by: EvidenceFindingsDecider; reason?: string },
  ): Promise<EvidenceFindingsBatch>
  /** The owner's change to one finding still waiting: its text and fields, never its evidence or project. */
  edit(
    id: string,
    finding: string,
    changes: Record<string, unknown>,
    options: { fingerprint: string; by: "owner" },
  ): Promise<EvidenceFindingsBatch>
  /** Each reference the batch cites, read back once; one gone from the store since is `missing`. */
  sources(id: string): Promise<EvidenceSource[]>
}
