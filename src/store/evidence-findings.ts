import { CliError } from "@wirecat/cli-base"
import { formatLocator, parseLocator } from "../domain/locator.js"
import { type FindingOutcome, type FindingsInput, type FindingsReceipt, validateFindings } from "../meetings/index.js"
import type { EvidenceSource } from "./sqlite/evidence-sources.js"

export const EVIDENCE_FINDINGS_KIND = "evidence_findings"

const reference = (raw: string) => {
  if (/^(document|note):[1-9]\d*$/.test(raw)) return raw
  try {
    return formatLocator(parseLocator(raw))
  } catch {
    throw new CliError("validation_error", "finding evidence is a msg:, document: or note: reference")
  }
}
export const validateEvidenceFindings = (input: FindingsInput): FindingsInput =>
  validateFindings(input, {
    plural: "evidence findings",
    singular: "evidence finding",
    cited: "reference",
    reference,
    anySubject: true,
  })

/** Who decided: the owner, or an agent the host let decide for the owner, with its reason. */
export type EvidenceFindingsDecider = "owner" | { bot: string; model?: string; reason: string }

export interface EvidenceFindingsReceipt extends FindingsReceipt {
  decision: { by: "owner" } | { by: "agent"; bot: string; model: string | null; reason: string }
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
  author: { type: "person" | "bot"; id: string; name: string | null }
  decidedBy: { type: "person" | "bot"; id: string } | null
  decidedAt: string | null
  previous: FindingOutcome[]
  receipt: EvidenceFindingsReceipt | null
}
/**
 * Cited facts and follow-ups about one project from stored messages, mail and documents, staged by an agent for
 * review. A sibling of meeting findings: the same rules, evidence checked against the current stored text.
 */
export interface EvidenceFindingsStore {
  stage(input: FindingsInput, agent: { bot: string; model?: string }): Promise<EvidenceFindingsBatch>
  get(id: string): Promise<EvidenceFindingsBatch>
  list(options?: {
    project?: string
    limit?: number
    offset?: number
    status?: "proposed" | "reviewed"
  }): Promise<{ items: EvidenceFindingsBatch[]; hasMore: boolean }>
  review(
    id: string,
    input: { fingerprint: string; accept: string[]; by?: EvidenceFindingsDecider },
  ): Promise<EvidenceFindingsBatch>
  /** Each reference the batch cites, read back once; one gone from the store since is `missing`. */
  sources(id: string): Promise<EvidenceSource[]>
}
