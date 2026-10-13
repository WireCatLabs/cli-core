export interface SearchIndexState {
  /** The highest message the batches must reach; newer ones are indexed by triggers. */
  watermark: number
  filledThrough: number
  pendingNormalization: number
  /** Every live message is in the word index: search may rank by words. */
  ready: boolean
  /** The typo vocabulary covers the messages up to this one; 0 while it is not built. */
  termsThrough: number
  /** The newest stored message. */
  newest: number
  /** The typo vocabulary covers every stored message; `ready` does not wait for it. */
  termsReady: boolean
  builtAt: string | null
}

export interface SearchIndexFill {
  normalized: number
  indexed: number
  terms: number
}
