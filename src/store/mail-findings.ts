import type { MailFindingProblem, MailFindingsInput } from "../mail/findings.js"
import type { FindingOutcome, FindingsReceipt } from "../meetings/index.js"
import type { Decider } from "./decisions.js"
import type { AccountKey } from "./types.js"

export const MAIL_FINDINGS_KIND = "mail_findings"

export interface MailFindingsBatch {
  id: string
  account: AccountKey
  input: MailFindingsInput
  fingerprint: string
  status: "proposed" | "reviewed"
  author: { type: "person" | "bot"; id: string; name: string | null; kind: "agent" | "rule" | null }
  decidedBy: { type: "person" | "bot"; id: string } | null
  decidedAt: string | null
  previous: FindingOutcome[]
  receipt: FindingsReceipt | null
}

/** What `stage` would do with a batch, found without writing anything. */
export interface MailFindingsCheck {
  valid: boolean
  findings: number
  /** The batch `stage` would give back: an earlier one under this key with this same input, else null. */
  batch: string | null
  problems: MailFindingProblem[]
}

/**
 * What an agent read in new mail — tasks, task updates, facts, memories, links, new contacts — cited and staged for
 * the owner, one batch per mailbox and run. Only the owner decides one: an agent's mail proposal never becomes the
 * owner's word without him.
 */
export interface MailFindingsStore {
  stage(
    account: AccountKey,
    input: MailFindingsInput,
    agent: { bot: string; model?: string },
  ): Promise<MailFindingsBatch>
  /**
   * Every check `stage` makes, the trial write of each invoice, payment and order included, rolled back: each
   * finding's problem is listed, not only the first. Input is the decoded JSON, before `validateMailFindings`.
   */
  check(
    account: AccountKey,
    input: MailFindingsInput,
    agent: { bot: string; model?: string },
  ): Promise<MailFindingsCheck>
  get(id: string): Promise<MailFindingsBatch>
  list(options?: {
    account?: AccountKey
    status?: "proposed" | "reviewed"
    limit?: number
    offset?: number
  }): Promise<{ items: MailFindingsBatch[]; hasMore: boolean }>
  review(id: string, input: { fingerprint: string; accept: string[]; by: Decider }): Promise<MailFindingsBatch>
}
