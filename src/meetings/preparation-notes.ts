import type { MeetingRelatedHistoryRequest } from "./related-history.js"

export interface MeetingPreparationNote {
  ref: string
  title: string | null
  text: string
  revision: number
  updatedAt: number
  person: string | null
  project: string | null
}

export interface MeetingPreparationNotesStore {
  /** Owner-written global notes through current explicit associations; no source revalidation. */
  preparationNotes(input: MeetingRelatedHistoryRequest): Promise<{
    items: MeetingPreparationNote[]
    hasMore: boolean
  }>
}
