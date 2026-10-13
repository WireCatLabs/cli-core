import type { AdminOptions, AdminRow, calculateAdminStatistics } from "../../domain/admin-statistics.js"
import type { CounterState } from "../../domain/counters.js"
import type { StoredHit } from "./models.js"

export interface AdminStoreRequest {
  options: AdminOptions
  evidence?: { entity: { account: { provider: string; account: string }; id: string }; cursor?: string }
}

export interface AdminEvidenceItem {
  message: StoredHit
  related?: StoredHit
  contribution: number | null
  counters?: CounterState[]
}

export interface AdminStoreResult {
  items: AdminRow[]
  total: number
  included: number
  hasMore: boolean
  cutoff: string
  summary: ReturnType<typeof calculateAdminStatistics>["summary"]
  quality: {
    graph: ReturnType<typeof calculateAdminStatistics>["graph"]
    archives: {
      account: { provider: string; account: string }
      chatId: string
      state: string
      fetchedAt: string | null
    }[]
    membership: "observed_stays_only" | "not_used"
    archivesTotal: number
    counterFreshness: "fresh" | "stale" | "partial" | "unknown"
    answererRoles: "user_selected_identities"
  }
  evidence?: AdminEvidenceItem[]
  nextCursor?: string | null
  fingerprint: string
  byteLimit: number
}
