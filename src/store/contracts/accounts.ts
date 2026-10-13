import type { AccountGroups, Profiles } from "../../search/account-list.js"
import type { AccountKey, StoredAccount } from "./models.js"

export interface AccountsStore {
  /** Answers the store's id for the account, which `meetings` and `mail` take. */
  saveAccount(key: AccountKey, account: { name: string | null }): Promise<number>

  /** The account groups `--source group:<name>` reads: each group's entries as saved, store-wide. */
  accountGroups(): Promise<AccountGroups>

  /** Saves one group's entries; `undefined` removes the group. */
  saveAccountGroup(name: string, members: string[] | undefined): Promise<void>

  /** Per app command, each profile's account: how `--source max:default` finds a profile of another app. */
  profiles(): Promise<Profiles>

  /** Records which account a profile of `app` is; a no-op when the store already says so. */
  saveProfile(app: string, profile: string, key: AccountKey): Promise<void>

  /** Every account of every messenger the file holds, by messenger then id. */
  accounts(): Promise<AccountKey[]>

  /** Every account with the store's id for it, by provider then external id. */
  storedAccounts(): Promise<StoredAccount[]>

  /** One account by provider and external id, never created: `not_found` when the store has none. */
  storedAccount(key: AccountKey): Promise<StoredAccount>

  /** The name the messenger last gave for this account; `null` when it never did. */
  accountName(key: AccountKey): Promise<string | null>
}
