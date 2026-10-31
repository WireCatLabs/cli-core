/** How many records match a search, every page together, shaped as Elasticsearch's `hits.total`. */
export interface SearchTotal {
  value: number
  /** `eq`: the exact count. `gte`: at least `value`; counting stopped at the cap or could not be done cheaply. */
  relation: "eq" | "gte"
}

/** Matches counted at most, as Elasticsearch's default `track_total_hits`; past it the total is `gte`. */
export const TOTAL_CAP = 10_000

/**
 * A total from a count capped at `TOTAL_CAP` (`undefined` when it could not be counted), never below what the pages
 * already showed: `shown` hits, and one more when `hasMore`.
 */
export const totalOf = (count: number | undefined, shown: number, hasMore: boolean, exact = true): SearchTotal => {
  const least = shown + (hasMore ? 1 : 0)
  if (count === undefined || count < least) return { value: least, relation: "gte" }
  if (count > TOTAL_CAP) return { value: TOTAL_CAP, relation: "gte" }
  return { value: count, relation: exact ? "eq" : "gte" }
}
