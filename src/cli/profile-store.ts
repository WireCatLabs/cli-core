import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isCliError } from "@wirecat/cli-base"
import { type AppIdentity, readOnlyLockOf } from "../ports/app.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey, StoredAccount } from "../store/types.js"

export interface ProfileStoreOptions {
  app: AppIdentity
  env: NodeJS.ProcessEnv
  profile: string
  /** The command only reads the store: the `readOnly` its category's `open` is given. */
  readOnly: boolean
  /** The service's provider, as the store names it: the empty store's account under the read-only lock. */
  provider: string
  /** Opens the shared store as the CLI does; a writable open also registers its provider. */
  open: (env: NodeJS.ProcessEnv, options?: { readOnly?: boolean }) => Promise<MessageStore>
  /**
   * The profile's account from its sign-in; asked only when no earlier run saved it. Without it the account is the
   * profile itself (`{ provider, account: profile }`, a phone system's), which a read also finds with no saved profile.
   */
  account?: () => AccountKey
  /**
   * `false`: this open never saves the account. A profile no run saved, or no store at all, reads an empty store in a
   * temporary folder, so a mistyped profile saves nothing; a store that needs a migration is still migrated. By
   * default a write saves the account, and so does the first read of a profile.
   */
  saves?: boolean
  /** The name a new account is saved with. */
  name?: string
}

export interface ProfileStore {
  store: MessageStore
  account: AccountKey
  /** The store's id for the account, which `meetings` and `mail` take. */
  accountId: number
}

/**
 * The store a command over one service account reads (a CRM's, a blog's, a phone system's), and the profile's account
 * in it. A read takes the account an earlier run saved, so it never reads the sign-in; the first read of a profile, a
 * store that is missing or needs a migration, and every sync and write open it for writing and save the account (scope
 * work, which the owner may change) and the profile, unless `saves` is `false`.
 *
 * Under `<PREFIX>_READ_ONLY` a read with no store or no saved profile reads an empty store in a temporary folder, so
 * the lock creates no `wirecat.db`; the folder goes when the store closes. A sync still writes, as a fetch may.
 */
export const openProfileStore = async (options: ProfileStoreOptions): Promise<ProfileStore> => {
  const { app, env, readOnly, open } = options
  const locked = readOnly && readOnlyLockOf(app, env) !== undefined
  const saves = options.saves !== false
  if (readOnly) {
    let missing = false
    const store = await open(env, { readOnly: true }).catch((error: unknown) => {
      missing = isCliError(error) && error.code === "not_found"
      if (locked && !missing) throw error
      return undefined
    })
    if (store) return (await known(store, options)) ?? (locked || !saves ? empty(options) : saved(options, env))
    if (missing && !saves) return empty(options)
  }
  if (locked) return empty(options)
  if (saves) return saved(options, env)
  return (await known(await open(env), options)) ?? empty(options)
}

const profileKey = ({ provider, profile }: ProfileStoreOptions): AccountKey => ({ provider, account: profile })

const known = async (store: MessageStore, options: ProfileStoreOptions): Promise<ProfileStore | undefined> => {
  const found = await savedAccount(store, options).catch(() => undefined)
  if (found) return { store, account: { provider: found.provider, account: found.account }, accountId: found.id }
  await store.close()
  return undefined
}

const savedAccount = async (store: MessageStore, options: ProfileStoreOptions): Promise<StoredAccount | undefined> => {
  const profile = (await store.accounts.profiles())[options.app.command]?.[options.profile]
  if (profile) return store.accounts.storedAccount({ provider: profile.provider, account: profile.account })
  return options.account ? undefined : store.accounts.storedAccount(profileKey(options))
}

const saved = (options: ProfileStoreOptions, env: NodeJS.ProcessEnv) =>
  withProfile(options, env, options.account?.() ?? profileKey(options))

const empty = async (options: ProfileStoreOptions): Promise<ProfileStore> => {
  const folder = mkdtempSync(join(tmpdir(), `${options.app.command}-empty-`))
  const removing = () => rmSync(folder, { recursive: true, force: true })
  try {
    const opened = await withProfile(
      options,
      { ...options.env, MESSAGING_STORE: join(folder, "wirecat.db") },
      profileKey(options),
    )
    const close = opened.store.close.bind(opened.store)
    opened.store.close = () => close().finally(removing)
    return opened
  } catch (error) {
    removing()
    throw error
  }
}

const withProfile = async (
  { app, profile, open, name }: ProfileStoreOptions,
  env: NodeJS.ProcessEnv,
  account: AccountKey,
): Promise<ProfileStore> => {
  const store = await open(env)
  try {
    // An account already stored keeps the scope the owner gave it.
    const accountId = await store.accounts.saveAccount(account, { name: name ?? null, scope: "work" })
    await store.accounts.saveProfile(app.command, profile, account)
    return { store, account, accountId }
  } catch (error) {
    await store.close()
    throw error
  }
}
