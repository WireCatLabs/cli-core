import type { ListResult } from "@wirecat/cli-base/standards"

/** One page from rows read with `limit + 1`: the extra row only says that another page exists. */
export const pageOfRows = <T>(rows: T[], limit: number, offset = 0): ListResult<T> =>
  rows.length > limit
    ? { items: rows.slice(0, limit), hasMore: true, nextOffset: offset + limit }
    : { items: rows, hasMore: false }
