import { sameAs } from "../search/account-list.js"
import { PERSONAL } from "../search/groups.js"
import { listContextOf } from "../services/search-kind.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"

export const workGroupHint = (key: AccountKey): string =>
  `add it to a work group: \`memo groups add work ${key.provider}:${key.account}\``

/**
 * A CRM account no saved group lists is only in `personal` (WC-ACCT-13), so a `personal` run reads its business
 * data; this says how to move it, and never asks.
 */
export const ungroupedHint = async (store: MessageStore, key: AccountKey): Promise<string | undefined> => {
  const { groups } = (await listContextOf(store, key, undefined)).membership
  const grouped = Object.entries(groups).some(([name, members]) => name !== PERSONAL && members.some(sameAs(key)))
  return grouped ? undefined : workGroupHint(key)
}
