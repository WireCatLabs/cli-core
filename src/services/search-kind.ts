import { CliError } from "@wirecat/cli-base"
import type { AppIdentity } from "../cli/app.js"
import { isKind, kindOf, providerNamed } from "../domain/providers.js"
import { entriesOfList, fitting, isAccountList, type ListContext, type SkippedSource } from "../search/account-list.js"
import type { AccountKey, MessageStore, StoredAccount } from "../store/store.js"

export type SearchKind = "messages" | "mail"

export const NO_MAIL = "no_mail"

export const MAIL = "email"
/** What a `--source` list is resolved against: the store's accounts, groups and profiles, and the app running. */
export const listContextOf = async (
  store: MessageStore,
  account: AccountKey,
  app: AppIdentity | undefined,
  stored?: StoredAccount[],
): Promise<ListContext> => {
  const all = stored ?? (await store.storedAccounts())
  // A fresh store has no row yet for the account it runs as.
  const held = all.some((one) => one.provider === account.provider && one.account === account.account)
    ? all
    : [...all, { id: 0, ...account, name: null, scope: "personal" as const }]
  return {
    held,
    groups: await store.accountGroups(),
    profiles: await store.profiles(),
    running: { provider: account.provider, ...(app ? { command: app.command } : {}) },
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
): Promise<{ accounts: AccountKey[]; skipped: SkippedSource[] } | undefined> => {
  if (source === undefined) return undefined
  const stored = await store.storedAccounts()
  // A provider the store holds by that very name, and all, personal and bots, keep their old path.
  const registered =
    isKind(source) || (providerNamed(source) !== undefined && !stored.some(({ provider }) => provider === source))
  if (!isAccountList(source) && !registered) return undefined
  const entries = entriesOfList(source, await listContextOf(store, account, app, stored))
  return fitting(entries, kind ? [kind] : ["messages", "mail"], `${app?.command ?? "tg"} search ${kind ?? "messages"}`)
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
  command = "tg",
  mailAccount?: string,
  listed = false,
): AccountKey[] => {
  if (mailAccount !== undefined && kind !== "mail")
    throw new CliError("validation_error", "--account names a mail account — search mail reads it")
  if (kind === undefined) return chosen
  if (kind === "messages") {
    if (explicit === MAIL)
      throw new CliError("validation_error", `mail is searched with \`${command} search mail\`, not search messages`)
    return chosen.filter(({ provider }) => kindOf(provider) === "messages")
  }
  if (explicit !== undefined && explicit !== MAIL && explicit !== "all")
    throw new CliError(
      "validation_error",
      `search mail reads mail only — \`${command} search messages\` searches ${explicit}`,
    )
  const mail = (listed ? chosen : held).filter(({ provider }) => kindOf(provider) === "mail")
  if (mail.length === 0)
    throw new CliError(
      "not_found",
      "no mail in the store yet — `memo mail <account> import --since <date>` imports it",
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
