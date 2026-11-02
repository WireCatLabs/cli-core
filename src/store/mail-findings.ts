import type { MailFindingsInput } from "../mail/findings.js"
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
  get(id: string): Promise<MailFindingsBatch>
  list(options?: {
    account?: AccountKey
    status?: "proposed" | "reviewed"
    limit?: number
    offset?: number
  }): Promise<{ items: MailFindingsBatch[]; hasMore: boolean }>
  review(id: string, input: { fingerprint: string; accept: string[]; by: Decider }): Promise<MailFindingsBatch>
}
