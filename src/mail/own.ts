import type { AccountKey, MessageStore } from "../store/index.js"
import { OWN_MAIL_ADDRESSES as OWN_ADDRESSES } from "../store/sqlite/own-identities.js"
/** Gmail's label on mail the account sent, as `decodedLabelName` gives `\\Sent`. */
export const SENT_LABEL = "Sent"
/** Sync state under a mail account: the addresses its sync was last given as the owner's, lower case, as JSON. */
export const OWN_MAIL_CONFIGURED = "mail_own_configured"

const normal = (address: string): string => address.trim().toLowerCase()

const storedList = async (store: MessageStore, key: AccountKey, name: string): Promise<string[] | undefined> => {
  const value = (await store.sync.syncState(key, name))?.value
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

const storedOwn = async (store: MessageStore, key: AccountKey): Promise<string[]> =>
  (await storedList(store, key, OWN_ADDRESSES)) ?? []

/** The mailbox address, the addresses the owner configured, and those the account's sent mail came from. */
export const ownAddresses = async (
  store: MessageStore,
  key: AccountKey,
  configured: readonly string[] = [],
): Promise<Set<string>> => new Set([key.account, ...configured, ...(await storedOwn(store, key))].map(normal))

/** Mail in the Sent folder or under Gmail's Sent label is the owner's whatever its From; otherwise its From says. */
export const sentByOwner = (
  from: string | null | undefined,
  own: ReadonlySet<string>,
  inSent = false,
): boolean | null => (inSent ? true : from == null ? null : own.has(normal(from)))

/** Only links the account rules made go: the owner's own link of an address stays. */
const disownIdentities = async (store: MessageStore, addresses: readonly string[]): Promise<void> => {
  const owner = await store.people.owner()
  for (const address of addresses) {
    const held = owner?.identities.some(
      ({ provider, id, method, linkedBy }) =>
        provider === "email" && id === address && method === "account" && linkedBy === "rules",
    )
    if (held) await store.people.unlinkIdentity({ provider: "email", id: address }, { method: "unlink", by: "rules" })
  }
}

/**
 * After a sync: the senders of the mail in Sent join the owner's addresses beside `configured`, the account's mail from
 * any of them becomes outgoing, and their identities join the owner as the account's own does. A `configured` list is
 * the whole list: an address no longer in it, with no mail in Sent, stops being the owner's, its mail outside Sent is
 * incoming again and its identity leaves the owner. Before the list was first kept, every stored address may have
 * been configured. Without a list nothing stored is dropped: a caller that does not know the list removes nothing.
 */
export const settleOwnMail = async (
  store: MessageStore,
  key: AccountKey,
  accountId: number,
  mailboxes: readonly string[],
  { name, now, configured }: { name: string; now: number; configured?: readonly string[] | undefined },
): Promise<void> => {
  const account = normal(key.account)
  const before = await storedOwn(store, key)
  const wanted = [...new Set((configured ?? []).map(normal))].filter((address) => address !== account).sort()
  const kept = configured === undefined ? wanted : await storedList(store, key, OWN_MAIL_CONFIGURED)
  const removed = configured === undefined ? [] : (kept ?? before).filter((address) => !wanted.includes(address))
  const found = await store.mail.markOwnMail(
    accountId,
    { addresses: [account, ...wanted, ...before.filter((address) => !removed.includes(address))], mailboxes, removed },
    now,
  )
  const others = found.filter((address) => address !== account)
  const dropped = before.filter((address) => !others.includes(address))
  if (configured !== undefined && (JSON.stringify(wanted) !== JSON.stringify(kept ?? []) || kept === undefined))
    await store.sync.setSyncState(key, OWN_MAIL_CONFIGURED, JSON.stringify(wanted))
  if (others.length === 0 && before.length === 0) return
  if (JSON.stringify(others) !== JSON.stringify([...before].sort()))
    await store.sync.setSyncState(key, OWN_ADDRESSES, JSON.stringify(others))
  await disownIdentities(store, dropped)
  // Saving the account again is what links its own identities, now with these addresses.
  await store.accounts.saveAccount(key, { name })
}
