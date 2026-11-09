import { sameAs } from "../search/account-list.js"
import { ALL } from "../search/groups.js"
import { listContextOf } from "../services/search-kind.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"

export const workGroupHint = (key: AccountKey): string =>
  `add it to a work group: \`memo groups add work ${key.provider}:${key.account}\``

/**
 * A CRM account no saved group lists is reachable only by reading everything (WC-ACCT-13); this says how to put
 * it in a work group, and never asks.
 */
export const ungroupedHint = async (store: MessageStore, key: AccountKey): Promise<string | undefined> => {
  const { groups } = (await listContextOf(store, key, undefined)).membership
  const grouped = Object.entries(groups).some(([name, members]) => name !== ALL && members.some(sameAs(key)))
  return grouped ? undefined : workGroupHint(key)
}
