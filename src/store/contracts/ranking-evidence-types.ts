import type { CounterState } from "../../domain/counters.js"
import type { AccountKey, StoredHit } from "./models.js"
import type { RankingRequest } from "./rankings-types.js"

export interface EvidenceTarget {
  account: AccountKey
  id: string
  chatId?: string
}

export interface RankingEvidenceRequest extends RankingRequest {
  target: EvidenceTarget
  component: string
  limit: number
  cursor?: string
}

export interface RankingEvidenceItem {
  message: StoredHit
  related?: StoredHit
  contribution: number | null
  counters?: CounterState[]
}

export interface RankedEvidence {
  items: RankingEvidenceItem[]
  total: number
  included: number
  hasMore: boolean
  nextCursor: string | null
  fingerprint: string
  component: string
  componentValue: number | null
  byteLimit: number
}
