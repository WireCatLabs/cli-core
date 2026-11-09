import { CliError } from "@wirecat/cli-base"
import { holdsKindOf, isDocumentAccountProvider, isFolderProvider, isKind, providerNamed } from "../domain/providers.js"
import { type AppIdentity, envName } from "../ports/app.js"
import {
  entriesOfList,
  fitting,
  isAccountList,
  keyOf,
  type ListContext,
  type SkippedSource,
} from "../search/account-list.js"
import { ALL, type GroupContext, groupEntries, groupMembership, hasGroup, OWNER_NOTES } from "../search/groups.js"
import type { AccountKey, MessageStore, StoredAccount } from "../store/store.js"

export type SearchKind = "messages" | "mail"

export const NO_MAIL = "no_mail"

export const MAIL = "email"
/** The group `<PREFIX>_GROUP_LOCK` pins this process to; `all`, every account, locks nothing. */
export const groupLockOf = (app: AppIdentity | undefined, env: NodeJS.ProcessEnv | undefined): string | undefined => {
  const lock = app === undefined || env === undefined ? undefined : env[envName(app, "GROUP_LOCK")]?.trim()
  return lock && lock.toLowerCase() !== ALL ? lock : undefined
}

/**
 * What a `--source` list is resolved against: the store's accounts, profiles and groups — the saved ones and `all`
 * (WC-ACCT-13) — and the app running. Under a group lock in the run's `env` it holds only that group's
 * accounts, so a reader that never scoped its run to the group still cannot name an account outside it.
 */
export const listContextOf = async (
  store: MessageStore,
  account: AccountKey,
  app: AppIdentity | undefined,
  stored?: StoredAccount[],
  env?: NodeJS.ProcessEnv,
): Promise<GroupContext> => {
  const all = stored ?? (await store.accounts.storedAccounts())
  // A fresh store has no row yet for the account it runs as.
  const held = all.some((one) => one.provider === account.provider && one.account === account.account)
    ? all
    : [...all, { id: 0, ...account, name: null, scope: "personal" as const }]
  const context: ListContext = {
    held,
    groups: await store.accounts.accountGroups(),
    profiles: await store.accounts.profiles(),
    running: { provider: account.provider, ...(app ? { command: app.command } : {}) },
  }
  const membership = groupMembership(context)
  const groups = groupEntries(context.groups)
  const lock = groupLockOf(app, env)
  if (lock === undefined) return { ...context, groups, membership }
  const members = hasGroup(membership.groups, lock) ? membership.groups[lock] : undefined
  if (!members)
    throw new CliError(
      "permission_error",
      `this process is locked to group ${lock} (${envName(app as AppIdentity, "GROUP_LOCK")}), which does not exist`,
    )
  const only = new Set([...members, OWNER_NOTES].map(keyOf))
  // A notes folder or a documents account is held under its own key but listed as `notes:<store id>`.
  const listedAs = (one: StoredAccount) =>
    isFolderProvider(one.provider) || isDocumentAccountProvider(one.provider)
      ? { provider: "notes", account: String(one.id) }
      : one
  return {
    ...context,
    held: held.filter((one) => only.has(keyOf(listedAs(one)))),
    groups: { [lock]: groups[lock] ?? [] },
    membership: {
      groups: { [lock]: members },
      duplicates: membership.duplicates.filter(({ groups: names }) => names.includes(lock)),
      suggested: membership.suggested.filter(({ group }) => group === lock),
      unresolved: membership.unresolved,
    },
    only,
  }
}

/**
 * `--source` as a list of accounts and groups: `undefined` when it is a bare word like `all` or `telegram`. The
 * accounts are those of `kind` the list names; an entry naming none of them is in `skipped`.
 */
export const listedAccounts = async (
  store: MessageStore,
  account: AccountKey,
  source: string | undefined,
  app: AppIdentity | undefined,
  kind?: SearchKind,
  env?: NodeJS.ProcessEnv,
): Promise<{ accounts: AccountKey[]; skipped: SkippedSource[] } | undefined> => {
  const lock = groupLockOf(app, env)
  if (source === undefined && lock === undefined) return undefined
  const stored = await store.accounts.storedAccounts()
  // A provider the store holds by that very name, and all, personal and bots, keep their old path.
  const registered =
    source !== undefined &&
    (isKind(source) || (providerNamed(source) !== undefined && !stored.some(({ provider }) => provider === source)))
  // Under a lock every read goes through the list, which holds only the group's accounts.
  if (lock === undefined && source !== undefined && !isAccountList(source) && !registered) return undefined
  const entries = entriesOfList(source ?? `group:${lock}`, await listContextOf(store, account, app, stored, env))
  return fitting(
    entries,
    kind ? [kind] : ["messages", "mail"],
    `${app ? `${app.command} ` : ""}search ${kind ?? "messages"}`,
  )
}

/**
 * The accounts a `search messages` or `search mail` reads, from those the query chose. `explicit` is the
 * source the owner named, so asking `search messages` for mail is an error rather than an empty answer.
 */
export const accountsOfKind = (
  kind: SearchKind | undefined,
  chosen: AccountKey[],
  held: readonly AccountKey[],
  explicit: string | undefined,
  command: string | undefined = undefined,
  mailAccount?: string,
  listed = false,
): AccountKey[] => {
  if (mailAccount !== undefined && kind !== "mail")
    throw new CliError("validation_error", "--account names a mail account — memo search mail reads it")
  if (kind === undefined) return chosen
  if (kind === "messages") {
    if (explicit === MAIL)
      throw new CliError("validation_error", "mail is searched with `memo search mail`, not search messages")
    return chosen.filter(({ provider }) => holdsKindOf(provider, "messages"))
  }
  if (explicit !== undefined && explicit !== MAIL && explicit !== "all")
    throw new CliError(
      "validation_error",
      `search mail reads mail only — \`${command === undefined ? "" : `${command} `}search messages\` searches ${explicit}`,
    )
  const mail = (listed ? chosen : held).filter(({ provider }) => holdsKindOf(provider, "mail"))
  if (mail.length === 0)
    throw new CliError(
      "not_found",
      "no mail in the store yet — `memo sync --only mail --since-time <time>` imports it",
      {
        reason: NO_MAIL,
      },
    )
  const address = mailAccount?.trim().toLowerCase()
  const chosenMail = address === undefined ? mail : mail.filter(({ account }) => account === address)
  if (chosenMail.length === 0)
    throw new CliError(
      "not_found",
      `no mail account ${mailAccount} in the store — it holds ${mail.map(({ account }) => account).join(", ")}`,
    )
  return chosenMail.map(({ provider, account }) => ({ provider, account }))
}
