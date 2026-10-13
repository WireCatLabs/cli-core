import type { RetentionCohort, RetentionOptions, RetentionStay } from "../../domain/retention.js"
import type { ChatCompleteness } from "./completeness-types.js"

export interface RetentionResult {
  chatId: string
  cutoff: string
  options: RetentionOptions
  items: RetentionCohort[]
  total: number
  included: number
  hasMore: boolean
  unknownJoin: number
  eligibleStays: number
  fingerprint: string
  evidence: RetentionStay[]
  evidenceTotal: number
  nextCursor: string | null
  byteLimit: number
  quality: {
    membership: "observed_checkpoints"
    toleranceMilliseconds: number
    archive: ChatCompleteness | null
    continuousSurvival: boolean
    groupSilentRate: null
  }
}
