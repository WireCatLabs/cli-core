import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isCliError } from "@wirecat/cli-base"
import { type AppIdentity, readOnlyLockOf } from "../../ports/app.js"
import type { MessageStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"

export interface CrmStoreOptions {
  app: AppIdentity
  env: NodeJS.ProcessEnv
  profile: string
  /** The command only reads the store: `CrmCommandOptions.open`'s `readOnly`. */
  readOnly: boolean
  /** The CRM's provider, as the store names it: the empty store's account under the read-only lock. */
  provider: string
  /** Opens the shared store as the CLI does; a writable open also registers its provider. */
  open: (env: NodeJS.ProcessEnv, options?: { readOnly?: boolean }) => Promise<MessageStore>
  /** The profile's account from its sign-in; asked only when no earlier run saved it. */
  account: () => AccountKey
}

/**
 * The store a CRM command reads, and the profile's account in it. A read takes the account an earlier run saved, so it
 * never reads the sign-in; the first read of a profile, a store that is missing or needs a migration, and every sync
 * and write open it for writing and save the account (scope work: a CRM is the owner's work) and the profile.
 *
 * Under `<PREFIX>_READ_ONLY` a read with no store or no saved profile reads an empty store in a temporary folder, so
 * the lock creates no `wirecat.db`; the folder goes when the store closes. A sync still writes, as a fetch may.
 */
export const openCrmStore = async (options: CrmStoreOptions): Promise<{ store: MessageStore; account: AccountKey }> => {
  const { app, env, profile, readOnly, open } = options
  const locked = readOnly && readOnlyLockOf(app, env) !== undefined
  if (readOnly) {
    const store = await open(env, { readOnly: true }).catch((error: unknown) => {
      if (locked && !(isCliError(error) && error.code === "not_found")) throw error
      return undefined
    })
    if (store) {
      const saved = await store.accounts
        .profiles()
        .then((all) => all[app.command]?.[profile])
        .catch(() => undefined)
      if (saved) return { store, account: { provider: saved.provider, account: saved.account } }
      await store.close()
    }
  }
  if (!locked) return withProfile(options, env, options.account())
  const folder = mkdtempSync(join(tmpdir(), `${app.command}-empty-`))
  const removing = () => rmSync(folder, { recursive: true, force: true })
  try {
    const empty = await withProfile(
      options,
      { ...env, MESSAGING_STORE: join(folder, "wirecat.db") },
      {
        provider: options.provider,
        account: profile,
      },
    )
    const close = empty.store.close.bind(empty.store)
    empty.store.close = () => close().finally(removing)
    return empty
  } catch (error) {
    removing()
    throw error
  }
}

const withProfile = async (
  { app, profile, open }: CrmStoreOptions,
  env: NodeJS.ProcessEnv,
  account: AccountKey,
): Promise<{ store: MessageStore; account: AccountKey }> => {
  const store = await open(env)
  try {
    // An account already stored keeps the scope the owner gave it.
    await store.accounts.saveAccount(account, { name: null, scope: "work" })
    await store.accounts.saveProfile(app.command, profile, account)
    return { store, account }
  } catch (error) {
    await store.close()
    throw error
  }
}
