import type { MeetingRelatedHistoryRequest } from "./related-history.js"

/** The same bounded, same-account series anchors used for related meeting history. */
export type MeetingPreparationKnowledgeRequest = MeetingRelatedHistoryRequest

export interface MeetingPreparationFact {
  ref: string
  type: string
  statement: string
  subject: string | null
  project: string | null
  updatedAt: number
  sharedPerson: boolean
  sharedProject: boolean
}

export interface MeetingPreparationKnowledgeStore {
  /** Accepted global person/project facts only; source evidence is not revalidated. */
  preparationKnowledge(input: MeetingPreparationKnowledgeRequest): Promise<{
    items: MeetingPreparationFact[]
    hasMore: boolean
  }>
}
