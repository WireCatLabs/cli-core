export interface StemsState {
  watermark: number
  filledThrough: number
  /** Messages written or edited since their stems were: queued by triggers, emptied by JS. */
  pending: number
  /** What built the stems; `null` until a fill claims the row. */
  built: string | null
  /** What this binary builds with the store's setting. */
  wanted: string
  /** Every live message is stemmed by `wanted`: stemmed search may run. */
  ready: boolean
  /**
   * Why it is not ready: still filling, built by other choices and waiting for `store reindex`, or the
   * store asks for choices only a newer tool knows.
   */
  cause?: "building" | "stemmer_changed" | "stemmer_unknown"
  builtAt: string | null
}

export interface StemsFill {
  stemmed: number
  drained: number
}
