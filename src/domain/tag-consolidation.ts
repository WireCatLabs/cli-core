export interface TagConsolidationOptions {
  sourceId: string
  survivorId: string
  expectedVocabularyFingerprint: string
  maxRows?: number
  maxReadBytes?: number
  sampleLimit?: number
  signal?: AbortSignal
}

export interface TagConsolidationPreview {
  source: { id: string; name: string }
  survivor: { id: string; name: string }
  vocabularyFingerprint: string
  previewFingerprint: string
  assignments: {
    source: number
    survivor: number
    overlappingTargets: number
    byTargetType: { type: string; source: number; survivor: number }[]
    samples: {
      id: string
      tagId: string
      targetType: string
      targetId: string
      source: string
      main: boolean
      authorType: string | null
      authorId: string | null
    }[]
  }
  aliases: { source: number; survivor: number; samples: { id: string; tagId: string; name: string }[] }
  automaticClaims: { source: number; survivor: number; overlappingChats: number }
  links: {
    total: number
    samples: {
      id: string
      fromType: string
      fromId: string
      toType: string | null
      toId: string | null
      kind: string
    }[]
  }
  coverage: {
    inspectedTables: readonly string[]
    completeWithinInspectedTables: true
    rows: number
    readBytes: number
    samplesComplete: boolean
    applySupported: false
  }
}

export interface TagConsolidationStore {
  previewTagConsolidation(options: TagConsolidationOptions): Promise<TagConsolidationPreview>
}
