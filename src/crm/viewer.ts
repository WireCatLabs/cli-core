import { normalCrmUserId } from "../domain/crm.js"
import { crmIdentityId } from "../store/sqlite/crm-rows.js"
import type { CopyViewer, MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import type { CrmSource } from "./source.js"

// A sync state, not a CRM setting: `config set` must never make a profile the administrator.
const VIEWERS = "crm:viewers"

interface Viewers {
  /** The CRM limits what its users see (NEED-2660): it names the sign-in's user or answers `isAdmin`. */
  limited: boolean
  /** Each user a sync signed in as, and whether the CRM said it is the administrator then. */
  admins: Record<string, boolean>
}

const viewersOf = async (store: MessageStore, account: AccountKey): Promise<Viewers | undefined> => {
  try {
    const found = JSON.parse((await store.sync.syncState(account, VIEWERS))?.value ?? "null") as Partial<Viewers> | null
    if (!found || typeof found.limited !== "boolean") return undefined
    return { limited: found.limited, admins: typeof found.admins === "object" && found.admins ? found.admins : {} }
  } catch {
    return undefined
  }
}

/**
 * What the sync's sign-in may read of the copy offline, asked while the sync is online anyway. Saved before the copy's
 * owner is checked, so another administrator's refused sync still records it; a failed answer records no.
 */
export const recordCrmViewer = async (
  source: CrmSource,
  store: MessageStore,
  account: AccountKey,
  self: string | undefined,
): Promise<void> => {
  const limited = self !== undefined || source.isAdmin !== undefined
  const known = await viewersOf(store, account)
  const admins = { ...(known?.admins ?? {}) }
  if (self !== undefined) admins[self] = source.isAdmin ? await source.isAdmin().catch(() => false) : false
  await store.sync.setSyncState(account, VIEWERS, JSON.stringify({ limited, admins } satisfies Viewers))
}

/**
 * Whose deals and leads of the copy a profile reads offline (SEC-197): every one when the CRM limits nobody or a sync
 * found `user` its administrator; otherwise, a copy no sync recorded the rule of too, only those assigned to `user`,
 * and none when `user` is unknown. The network is never asked.
 */
export const crmViewerOf = async (
  store: MessageStore,
  account: AccountKey,
  user: string | undefined,
): Promise<CopyViewer | undefined> => {
  const known = await viewersOf(store, account)
  if (known?.limited === false) return undefined
  const id = user === undefined ? undefined : normalCrmUserId(user)
  if (id !== undefined && known?.admins[id] === true) return undefined
  return { account, assignee: id === undefined ? null : crmIdentityId(account, id, "user") }
}
