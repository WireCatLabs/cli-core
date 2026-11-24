import type { AccountKey, MessageStore } from "../store/index.js"
import { OWN_MAIL_ADDRESSES as OWN_ADDRESSES } from "../store/sqlite/own-identities.js"
/** Gmail's label on mail the account sent, as `decodedLabelName` gives `\\Sent`. */
export const SENT_LABEL = "Sent"

const normal = (address: string): string => address.trim().toLowerCase()

const storedOwn = async (store: MessageStore, key: AccountKey): Promise<string[]> => {
  const value = (await store.sync.syncState(key, OWN_ADDRESSES))?.value
  if (value === undefined) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

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

/**
 * After a sync: the senders of the mail in Sent join the owner's addresses, the account's mail from any of them
 * becomes outgoing, and their identities join the owner as the account's own does.
 */
export const settleOwnMail = async (
  store: MessageStore,
  key: AccountKey,
  accountId: number,
  own: ReadonlySet<string>,
  mailboxes: readonly string[],
  { name, now }: { name: string; now: number },
): Promise<void> => {
  const before = await storedOwn(store, key)
  const found = await store.mail.markOwnMail(accountId, { addresses: [...own], mailboxes }, now)
  const others = found.filter((address) => address !== normal(key.account))
  if (others.length === 0 && before.length === 0) return
  if (JSON.stringify(others) !== JSON.stringify([...before].sort()))
    await store.sync.setSyncState(key, OWN_ADDRESSES, JSON.stringify(others))
  // Saving the account again is what links its own identities, now with these addresses.
  await store.accounts.saveAccount(key, { name })
}
