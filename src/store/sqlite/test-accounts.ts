import { purgeAccount } from "./accounts.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

/** Set by store version 48 and deleted once the purge ran. */
export const TEST_ACCOUNTS_TO_PURGE = "test_accounts_to_purge"

/** The fake messenger of `src/testing/shared-program.ts`; no tool writes it. */
const TEST_PROVIDER = "chat"

/**
 * Removes every account of the test provider, as `cache clear` removes one. A failure keeps the key for the next open
 * and only warns: a leftover test account must never stop the owner's store from opening.
 */
export const purgeTestAccounts = (context: StoreContext, warn: (line: string) => void): number => {
  const { database } = context
  if (!database.prepare("SELECT 1 AS found FROM store_settings WHERE key = ?").get(TEST_ACCOUNTS_TO_PURGE)) return 0
  try {
    return write(database, () => {
      const pks = database
        .prepare("SELECT id FROM accounts WHERE provider = ? ORDER BY id")
        .all(TEST_PROVIDER)
        .map((row) => Number(row.id))
      for (const pk of pks) purgeAccount(context, pk)
      database.prepare("DELETE FROM store_settings WHERE key = ?").run(TEST_ACCOUNTS_TO_PURGE)
      return pks.length
    })
  } catch (error) {
    warn(`could not remove the test accounts from the store; the next open tries again: ${String(error)}`)
    return 0
  }
}
