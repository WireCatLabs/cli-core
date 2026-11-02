import type { FindingOutcome, MeetingFindingsInput, MeetingFindingsReceipt } from "../meetings/index.js"
import type { Decider } from "./decisions.js"
import type { AccountKey } from "./types.js"

export interface MeetingFindingsBatch {
  id: string
  account: AccountKey
  input: MeetingFindingsInput
  fingerprint: string
  status: "proposed" | "reviewed"
  author: { type: "person" | "bot"; id: string; name: string | null }
  decidedBy: { type: "person" | "bot"; id: string } | null
  decidedAt: string | null
  previous: FindingOutcome[]
  receipt: MeetingFindingsReceipt | null
}
export interface MeetingFindingsStore {
  stage(
    account: AccountKey,
    input: MeetingFindingsInput,
    agent: { bot: string; model?: string },
  ): Promise<MeetingFindingsBatch>
  get(account: AccountKey, id: string): Promise<MeetingFindingsBatch>
  list(
    account: AccountKey,
    options?: { limit?: number; offset?: number; status?: "proposed" | "reviewed" },
  ): Promise<{ items: MeetingFindingsBatch[]; hasMore: boolean }>
  review(
    account: AccountKey,
    id: string,
    input: { fingerprint: string; accept: string[]; by: Decider },
  ): Promise<MeetingFindingsBatch>
}
