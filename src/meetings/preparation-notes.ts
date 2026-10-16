import type { MeetingRelatedHistoryRequest } from "./related-history.js"

export type MeetingPreparationNotesSelection =
  | "owner-written-global-person/project-notes"
  | "owner-written-meeting/person/project-notes"

export interface MeetingPreparationNote {
  ref: string
  title: string | null
  text: string
  revision: number
  updatedAt: number
  person: string | null
  project: string | null
  meeting?: string | null
}

export interface MeetingPreparationNotesStore {
  /** Owner-written notes through current explicit associations; no source revalidation. */
  preparationNotes(input: MeetingRelatedHistoryRequest): Promise<{
    items: MeetingPreparationNote[]
    hasMore: boolean
    selection?: MeetingPreparationNotesSelection
  }>
}
