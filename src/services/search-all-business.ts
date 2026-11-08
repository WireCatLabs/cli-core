import { INTERNAL_NOTES } from "../domain/providers.js"
import { type AccountKey, BUSINESS_FIND_MAX, type BusinessHit, type MessageStore } from "../store/store.js"
import type { SearchAllItem } from "./search-all.js"

/** The account a hit of the owner's own invoice, product or wallet names: no import made it. */
export const OWN_BUSINESS: AccountKey = { provider: "business", account: INTERNAL_NOTES }

export const BUSINESS_WORDS_ONLY =
  "invoices, payments, orders, contracts, subscriptions, products and wallets are found by the words of their " +
  "numbers and names only"

export interface BusinessLane {
  items: SearchAllItem[]
  hasMore: boolean
  /** Every account read. */
  read: AccountKey[]
}

/**
 * A hit's account is its source record's. An imported row whose records all moved to other entities keeps its import
 * provider with no account, so it is never taken for the owner's own.
 */
const placeOf = ({ source, imported }: BusinessHit): AccountKey =>
  source ?? (imported === undefined ? OWN_BUSINESS : { provider: imported, account: "" })

/** The `business` lane: numbers and names folded in memory, each hit titled as its ref reads everywhere else. */
export const searchBusiness = async (
  store: MessageStore,
  {
    words,
    anyWord,
    window,
    accounts,
  }: { words: string[]; anyWord: boolean; window: number; accounts: AccountKey[] | undefined },
): Promise<BusinessLane> => {
  const asked = Math.min(window + 1, BUSINESS_FIND_MAX)
  const found = await store.business.find({
    words,
    anyWord,
    limit: asked,
    ...(accounts === undefined ? {} : { accounts }),
  })
  const page = found.slice(0, window)
  const titles = await store.refs.summaries(page.map(({ ref }) => ref))
  return {
    items: page.map((hit) => ({
      kind: hit.kind,
      ref: hit.ref,
      ...placeOf(hit),
      title: titles.get(hit.ref)?.title ?? null,
      timestamp: new Date(hit.updatedAt).toISOString(),
      text: hit.text,
      review: hit.review,
      ...(hit.source === undefined ? {} : { sourceRecord: hit.source }),
      foundBy: ["title"],
    })),
    hasMore: found.length > window || (asked < window + 1 && found.length === asked),
    read: accounts ?? [...(await store.business.accounts()), OWN_BUSINESS],
  }
}
