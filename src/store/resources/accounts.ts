import { ACCOUNT_GROUPS } from "../../search/account-list.js"
import type { AccountsStore } from "../contracts/accounts.js"
import { accountGroupsOf, profilesOf, saveProfile } from "../sqlite/account-groups.js"
import * as accounts from "../sqlite/accounts.js"
import { linkInbox } from "../sqlite/tasks.js"
import type { StoreRuntime } from "./runtime.js"

export const accountsStoreOver = ({
  context,
  database,
  inTransaction,
  accountPk,
}: Pick<StoreRuntime, "context" | "database" | "inTransaction" | "accountPk">): AccountsStore => {
  return {
    saveAccount: async (key, { name }) => {
      const pk = accountPk(key, name)
      linkInbox(database, `${key.provider}:${key.account}`, pk)
      return pk
    },

    accounts: async () => accounts.heldAccounts(context),

    storedAccounts: async () => accounts.storedAccounts(context),

    storedAccount: async (key) => accounts.storedAccount(context, key),

    accountName: async (key) => accounts.accountName(context, key),

    accountGroups: async () => accountGroupsOf(database),

    profiles: async () => profilesOf(database),

    saveProfile: async (app, profile, key) =>
      inTransaction(() => saveProfile(database, app, profile, key, context.now())),

    saveAccountGroup: async (name, members) =>
      inTransaction(() => {
        const groups = accountGroupsOf(database)
        if (members === undefined) delete groups[name]
        else groups[name] = members
        database
          .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
          .run(ACCOUNT_GROUPS, JSON.stringify(groups), context.now())
      }),
  }
}
