import type { ProviderEntry } from "../domain/providers.js"
import { ACCOUNT_GROUPS, type AccountGroups, type Profiles } from "../search/account-list.js"
import { keysOver } from "./keys.js"
import { accountGroupsOf, forgetProfile, profilesOf, saveProfile } from "./sqlite/account-groups.js"
import * as accounts from "./sqlite/accounts.js"
import type { StoreContext } from "./sqlite/open.js"
import { linkOwnIdentities } from "./sqlite/own-identities.js"
import { registerProvider } from "./sqlite/providers.js"
import { linkInbox } from "./sqlite/tasks.js"
import { write } from "./sqlite/transaction.js"
import type { AccountKey, StoredAccount } from "./types.js"

export interface AccountAccounts {
  /**
   * Answers the store's id for the account, which `meetings` and `mail` take. `scope` is what a new account starts
   * as (a CRM's `work`); an account already stored keeps the scope it has.
   */
  saveAccount(key: AccountKey, account: { name: string | null; scope?: StoredAccount["scope"] }): Promise<number>
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

export interface AccountGroupChange {
  /** Read against the group's entries inside the write, so a move sees what is saved at that moment. */
  remove?: { group: string; drop: (entry: string) => boolean }
  add?: { group: string; entry: string }
}

export interface AccountsStore extends AccountAccounts {
  /** Every account of every messenger the file holds, by messenger then id. */
  accounts(): Promise<AccountKey[]>
  /** Every account with the store's id for it, by provider then external id. */
  storedAccounts(): Promise<StoredAccount[]>
  /**
   * The owner's choice of an account's scope, personal or work; what search copied of the old one follows. A
   * missing account is `not_found`.
   */
  setScope(key: AccountKey, scope: StoredAccount["scope"]): Promise<StoredAccount>
  /** The account groups `--source group:<name>` reads: each group's entries as saved, store-wide. */
  accountGroups(): Promise<AccountGroups>
  /** Saves one group's entries; `undefined` removes the group. */
  saveAccountGroup(name: string, members: string[] | undefined): Promise<void>
  /**
   * Takes entries out of one group and puts an entry into another in one write, so a move is never half done. A
   * group left empty stays, to be filled again; an entry already there is not added twice.
   */
  changeAccountGroups(change: AccountGroupChange): Promise<{ removed: string[] }>
  /** Per app command, each profile's account: how `--source max:default` finds a profile of another app. */
  profiles(): Promise<Profiles>
  /** Records which account a profile of `app` is; a no-op when the store already says so. */
  saveProfile(app: string, profile: string, key: AccountKey): Promise<void>
  /** Forgets which account a profile of `app` is; a no-op when the store never knew. */
  forgetProfile(app: string, profile: string): Promise<void>
  /** Writes a CLI's provider entry for every tool on this store to read; see `registerProvider`. */
  registerProvider(entry: ProviderEntry): Promise<void>
}

export const accountAccountsOver = (context: StoreContext): AccountAccounts => {
  const { database } = context
  const { accountPk, findAccountPk } = keysOver(context)
  return {
    saveAccount: async (key, { name, scope }) => {
      const pk = write(database, () => {
        const made = accountPk(key, name, scope)
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
  const saveGroups = (groups: AccountGroups) =>
    database
      .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
      .run(ACCOUNT_GROUPS, JSON.stringify(groups), context.now())
  return {
    ...keyed,
    accounts: async () => accounts.heldAccounts(context),
    storedAccounts: async () => accounts.storedAccounts(context),
    setScope: async (key, scope) => write(database, () => accounts.setAccountScope(context, key, scope)),
    accountGroups: async () => accountGroupsOf(database),
    profiles: async () => profilesOf(database),
    saveProfile: async (app, profile, key) =>
      write(database, () => saveProfile(database, app, profile, key, context.now())),
    forgetProfile: async (app, profile) => write(database, () => forgetProfile(database, app, profile, context.now())),
    registerProvider: async (entry) => registerProvider(database, entry, context.now()),
    saveAccountGroup: async (name, members) =>
      write(database, () => {
        const groups = accountGroupsOf(database)
        if (members === undefined) delete groups[name]
        else groups[name] = members
        saveGroups(groups)
      }),
    changeAccountGroups: async ({ remove, add }) =>
      write(database, () => {
        const groups = accountGroupsOf(database)
        const saved = remove && Object.hasOwn(groups, remove.group) ? (groups[remove.group] ?? []) : []
        const removed = remove ? saved.filter(remove.drop) : []
        if (remove && removed.length) groups[remove.group] = saved.filter((entry) => !removed.includes(entry))
        if (add) {
          const entries = Object.hasOwn(groups, add.group) ? (groups[add.group] ?? []) : []
          groups[add.group] = entries.includes(add.entry) ? entries : [...entries, add.entry]
        }
        if (removed.length || add) saveGroups(groups)
        return { removed }
      }),
  }
}
