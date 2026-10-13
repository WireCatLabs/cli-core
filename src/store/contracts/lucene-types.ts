/** The tables one kind of searchable item lives in; the compiler names its row `m` and its thread `c`. */
export interface Corpus {
  rows: string
  threads: string
  words: string
  stems: string
  vocab: string
  item: string
  thread: string
}

export type QueryGrouping = "chat" | "sender" | "time"

export interface QueryGroup {
  provider?: string
  account?: string
  id: string | null
  name: string | null
  outgoing?: boolean
  count: number
}
