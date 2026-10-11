import { CliError } from "@wirecat/cli-core"
import type { AppIdentity } from "../cli/app.js"
import { accountsOfList, isAccountList } from "../search/account-list.js"
import type { AccountKey, MessageStore } from "../store/store.js"

export type SearchKind = "messages" | "mail"

export const NO_MAIL = "no_mail"

export const MAIL = "email"
/** Notes stored as messages before store version 25: `search notes` reads their own table now. */
const OLD_NOTES = "notes"

/** `--source` as a list of accounts and groups: `undefined` when it is a bare word like `all` or `telegram`. */
export const listedAccounts = async (
  store: MessageStore,
  account: AccountKey,
  source: string | undefined,
  app: AppIdentity | undefined,
): Promise<AccountKey[] | undefined> => {
  if (source === undefined || !isAccountList(source)) return undefined
  const stored = await store.storedAccounts()
  const held = stored.some((one) => one.provider === account.provider && one.account === account.account)
    ? stored
    : [...stored, { id: 0, ...account, name: null, scope: "personal" as const }]
  return accountsOfList(source, {
    held,
    groups: await store.accountGroups(),
    profiles: await store.profiles(),
    running: { provider: account.provider, ...(app ? { command: app.command } : {}) },
  })
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
    const messages = chosen.filter(({ provider }) => provider !== MAIL && provider !== OLD_NOTES)
    if (listed && messages.length === 0)
      throw new CliError(
        "validation_error",
        `the accounts named are mailboxes only — \`${command} search mail\` reads them`,
      )
    return messages
  }
  if (explicit !== undefined && explicit !== MAIL && explicit !== "all")
    throw new CliError(
      "validation_error",
      `search mail reads mail only — \`${command} search messages\` searches ${explicit}`,
    )
  const mail = (listed ? chosen : held).filter(({ provider }) => provider === MAIL)
  if (listed && mail.length === 0)
    throw new CliError("validation_error", "the accounts named hold no mailbox — search mail reads mail only")
  if (mail.length === 0)
    throw new CliError("not_found", "no mail in the store yet — `memo mail import --since <date>` imports it", {
      reason: NO_MAIL,
    })
  const address = mailAccount?.trim().toLowerCase()
  const chosenMail = address === undefined ? mail : mail.filter(({ account }) => account === address)
  if (chosenMail.length === 0)
    throw new CliError(
      "not_found",
      `no mail account ${mailAccount} in the store — it holds ${mail.map(({ account }) => account).join(", ")}`,
    )
  return chosenMail.map(({ provider, account }) => ({ provider, account }))
}
