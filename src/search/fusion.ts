/** Reciprocal rank fusion's usual constant, as conversations use. */
export const RRF_K = 60

export interface FusedFacts {
  /** The hit holds the exact forms of the words, when the search was stemmed. */
  exact?: boolean | undefined
  /** Its index ranked it by relevance; an unranked hit came by a field, a transcript or a file. */
  ranked: boolean
  /** Milliseconds: what breaks a tie, newest first. */
  at: number
}

/**
 * Lists, each best first from its own index, as one list best first. Raw scores of two word indexes never compare
 * (each BM25 depends on its own corpus), so a hit's place in its own list votes instead, by reciprocal rank fusion;
 * that place also carries the transcript and file tiers the list was sorted by. Exact hits stay first and ranked
 * ones before unranked, as within one list. With nothing ranked, newest first.
 */
export const fuseRanked = <T>(lists: readonly (readonly T[])[], facts: (item: T) => FusedFacts): T[] => {
  const rows = lists.flatMap((list) =>
    list.map((item, rank) => ({ item, vote: 1 / (RRF_K + rank + 1), ...facts(item) })),
  )
  const ranking = rows.some(({ ranked }) => ranked)
  return rows
    .sort(
      (a, b) =>
        Number(b.exact === true) - Number(a.exact === true) ||
        (ranking ? Number(b.ranked) - Number(a.ranked) || b.vote - a.vote : 0) ||
        b.at - a.at,
    )
    .map(({ item }) => item)
}
