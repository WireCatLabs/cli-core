import type { CrmLiveQuery, CrmPage } from "./source.js"

/** One page as the CRM gave it, and whether it said more come after. */
export interface CrmRows<T> {
  rows: T[]
  more: boolean
}

/** Which rows an answer page holds: `limit` rows after `offset`. */
export interface CrmWindow {
  offset: number
  limit: number
}

/** The rows a live query's page asks for: its page number, from 1, and its size. */
export const crmWindowOf = (query: Pick<CrmLiveQuery, "limit" | "page">): CrmWindow => {
  const page = query.page ?? 1
  return { offset: (Number.isSafeInteger(page) && page > 1 ? page - 1 : 0) * query.limit, limit: query.limit }
}

/**
 * For a CRM that pages by offset only. The rows of one answer page, read from the CRM in its own page sizes, up to `largest` a request: one more than asked,
 * so `hasMore` is known without a total, which many CRMs do not give.
 */
export const walk = async <T>(
  window: CrmWindow,
  largest: number,
  fetchPage: (offset: number, size: number) => Promise<CrmRows<T>>,
): Promise<CrmPage<T>> => {
  const want = window.limit + 1
  const rows: T[] = []
  let at = window.offset
  while (rows.length < want) {
    const page = await fetchPage(at, Math.min(largest, want - rows.length))
    for (const row of page.rows) rows.push(row)
    at += page.rows.length
    if (!page.more || page.rows.length === 0) break
  }
  return { items: rows.slice(0, window.limit), hasMore: rows.length > window.limit }
}
