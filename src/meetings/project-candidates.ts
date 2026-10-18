export interface MeetingProjectCandidateInput {
  reference: string
  title?: string
  cues?: {
    reference: string
    fingerprint: string
    text: string
    revision: "current" | "superseded"
  }[]
}

export interface MeetingProjectCandidateOptions {
  limit?: number
  maxProjects?: number
  maxVocabularyReadBytes?: number
  bytes?: number
  signal?: AbortSignal
}

export interface MeetingProjectCandidateMatch {
  term: { name: string; kind: "canonical" | "key" | "alias"; aliasId?: string }
  ambiguous: boolean
  source: {
    kind: "metadata-title" | "transcript"
    reference: string
    fingerprint: string | null
    revision: "current" | "superseded" | null
  }
}

export interface MeetingProjectCandidates {
  schemaVersion: 1
  kind: "meeting_project_candidates"
  source: { provider: string; account: string; accountId: number; reference: string }
  inputFingerprint: string
  vocabularyFingerprint: string
  association: "unconfirmed-literal-evidence"
  items: {
    project: { reference: string; id: string; name: string; key: string | null }
    matches: MeetingProjectCandidateMatch[]
    omittedMatches: number
  }[]
  limits: { limit: number; maxProjects: number; maxVocabularyReadBytes: number; bytes: number }
  coverage: {
    selection: "explicit-host-evidence/global-project-vocabulary"
    sourceEvidence: "not-revalidated"
    association: "unconfirmed-literal-evidence"
    archiveCompleteness: "unknown"
    omittedMatches: number
    candidatesTotal: number
    hasMore: boolean
    outputLimited: boolean
    matching: "unicode-normalized-literal-word-boundaries"
  }
}

export type MeetingProjectCandidateReader = (
  input: MeetingProjectCandidateInput,
  options?: MeetingProjectCandidateOptions,
) => Promise<MeetingProjectCandidates>
