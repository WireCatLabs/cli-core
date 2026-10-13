export interface MeetingVectorHit {
  meetingId: number
  transcriptId: number
  firstPosition: number
  lastPosition: number
  hash: string
  score: number
}

export interface MeetingVectors {
  saveCurrent(
    model: string,
    dims: number,
    rows: { hash: string; vector: Float32Array }[],
    input: Scope,
  ): Promise<{ saved: number; skipped: number }>
  rebuild(
    input: Scope & TextBudget & { afterTranscriptId?: number; limit?: number },
  ): Promise<{ transcripts: number; chunks: number; hasMore: boolean; nextTranscriptId?: number }>
  chunksToEmbed(
    model: string,
    input: Scope & TextBudget & { afterHash?: string; limit: number },
  ): Promise<{ items: { hash: string; text: string }[]; hasMore: boolean; nextHash?: string }>
  nearest(
    model: string,
    query: Float32Array,
    input: Scope & TextBudget & { limit: number; maxChunks?: number; afterChunkId?: number },
  ): Promise<{
    items: MeetingVectorHit[]
    ranking: "scanned-candidates"
    scanned: number
    complete: boolean
    hasMore: boolean
    nextChunkId?: number
  }>
  status(input: Scope & { model: string }): Promise<{ chunks: number; embedded: number }>
}

export interface Scope {
  accountId: number
  signal?: AbortSignal
}

export interface TextBudget {
  maxRows?: number
  maxTextBytes?: number
}
