import type { ProviderEntry } from "../domain/providers.js"
import { ACCOUNT_GROUPS, type AccountGroups, type Profiles } from "../search/account-list.js"
import { keysOver } from "./keys.js"
import { accountGroupsOf, profilesOf, saveProfile } from "./sqlite/account-groups.js"
import * as accounts from "./sqlite/accounts.js"
import type { StoreContext } from "./sqlite/open.js"
import { linkOwnIdentities } from "./sqlite/own-identities.js"
import { registerProvider } from "./sqlite/providers.js"
import { linkInbox } from "./sqlite/tasks.js"
import { write } from "./sqlite/transaction.js"
import type { AccountKey, StoredAccount } from "./types.js"

export interface AccountAccounts {
  /** Answers the store's id for the account, which `meetings` and `mail` take. */
  saveAccount(key: AccountKey, account: { name: string | null }): Promise<number>
  /** One account by provider and external id, never created: `not_found` when the store has none. */
  storedAccount(key: AccountKey): Promise<StoredAccount>
  /** The name the messenger last gave for this account; `null` when it never did. */
  accountName(key: AccountKey): Promise<string | null>
  /**
   * Everything one account holds — its chats, messages, members, state, leases, transcripts and whom
   * it has seen — for `cache clear`. Other accounts, and identities they share, stay.
   */
  purge(key: AccountKey): Promise<void>
}

export interface AccountsStore extends AccountAccounts {
  /** Every account of every messenger the file holds, by messenger then id. */
  accounts(): Promise<AccountKey[]>
  /** Every account with the store's id for it, by provider then external id. */
  storedAccounts(): Promise<StoredAccount[]>
  /** The account groups `--source group:<name>` reads: each group's entries as saved, store-wide. */
  accountGroups(): Promise<AccountGroups>
  /** Saves one group's entries; `undefined` removes the group. */
  saveAccountGroup(name: string, members: string[] | undefined): Promise<void>
  /** Per app command, each profile's account: how `--source max:default` finds a profile of another app. */
  profiles(): Promise<Profiles>
  /** Records which account a profile of `app` is; a no-op when the store already says so. */
  saveProfile(app: string, profile: string, key: AccountKey): Promise<void>
  /** Writes a CLI's provider entry for every tool on this store to read; see `registerProvider`. */
  registerProvider(entry: ProviderEntry): Promise<void>
}

export const accountAccountsOver = (context: StoreContext): AccountAccounts => {
  const { database } = context
  const { accountPk, findAccountPk } = keysOver(context)
  return {
    saveAccount: async (key, { name }) => {
      const pk = write(database, () => {
        const made = accountPk(key, name)
        linkInbox(database, `${key.provider}:${key.account}`, made)
        return made
      })
      linkOwnIdentities(context)
      return pk
    },
    storedAccount: async (key) => accounts.storedAccount(context, key),
    accountName: async (key) => accounts.accountName(context, key),
    purge: async (key) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return
      write(database, () => accounts.purgeAccount(context, accountKey))
    },
  }
}

export const accountsStoreOver = (context: StoreContext, keyed: AccountAccounts): AccountsStore => {
  const { database } = context
  return {
    ...keyed,
    accounts: async () => accounts.heldAccounts(context),
    storedAccounts: async () => accounts.storedAccounts(context),
    accountGroups: async () => accountGroupsOf(database),
    profiles: async () => profilesOf(database),
    saveProfile: async (app, profile, key) =>
      write(database, () => saveProfile(database, app, profile, key, context.now())),
    registerProvider: async (entry) => registerProvider(database, entry, context.now()),
    saveAccountGroup: async (name, members) =>
      write(database, () => {
        const groups = accountGroupsOf(database)
        if (members === undefined) delete groups[name]
        else groups[name] = members
        database
          .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
          .run(ACCOUNT_GROUPS, JSON.stringify(groups), context.now())
      }),
  }
}
