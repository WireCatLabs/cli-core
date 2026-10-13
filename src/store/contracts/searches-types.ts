export type SearchCommand = "search" | "stats" | "message-top" | "author-top" | "admin-statistics"

/** What one run or one saved search is: `params` as canonical JSON, so the same run is the same text. */
export interface SearchRecord {
  command: SearchCommand
  params: string
  language: string
  version: number
  fieldsVersion: number
}

export interface StoredSearch {
  id: string
  name: string | null
  command: SearchCommand
  params: Record<string, unknown>
  language: string
  version: number
  fieldsVersion: number
  createdAt: string
  lastRunAt: string | null
  runs: number
}
