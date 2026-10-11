import { CliError } from "@wirecat/cli-core"
import type { Provider } from "../domain/models.js"
import type { AccountKey, StoredAccount } from "../store/store.js"
import { inSource, type Source } from "./query.js"

/** Store-wide: every profile, tg, MAX and memo reads the same groups. */
export const ACCOUNT_GROUPS = "accountGroups"

export type AccountGroups = Record<string, string[]>

const GROUP_NAME = /^[a-z0-9][a-z0-9_-]*$/i

const fail = (message: string): never => {
  throw new CliError("validation_error", message)
}

/** A bare `all` or `telegram` keeps meaning what it always did; a comma or a `:` makes it a list. */
export const isAccountList = (value: string): boolean => value.includes(",") || value.includes(":")

const itemsOf = (value: string): string[] => {
  const items = value.split(",").map((item) => item.trim())
  if (items.some((item) => item === "")) fail(`"${value}" has an empty entry — separate accounts with one comma`)
  return items
}

export const groupName = (name: string): string =>
  GROUP_NAME.test(name) ? name : fail(`a group name is letters, digits, - and _ — not "${name}"`)

/** What `config set accountGroups.<name>` saves: the entries as written, so each app resolves its own profiles. */
export const groupMembers = (value: string): string[] =>
  itemsOf(value).map((item) =>
    item.toLowerCase().startsWith("group:")
      ? fail(`a group lists accounts, not other groups — "${item}"`)
      : item.includes(":") && item.split(":")[1] === ""
        ? fail(`"${item}" names no account after the colon`)
        : item,
  )

const describe = (accounts: readonly StoredAccount[]) =>
  accounts.map(({ provider, account, name }) => `${provider}:${account}${name ? ` (${name})` : ""}`).join(", ")

export interface ListContext {
  held: readonly StoredAccount[]
  groups: AccountGroups
  /** The provider of the app running, and the command people call it by (`tg` for telegram). */
  running: { provider: Provider; command?: string }
  /** The account a profile of the running app logged in to. */
  profile?: (name: string) => string | undefined
  profiles?: () => string[]
}

const providerOf = (prefix: string, { held, running }: ListContext): Provider => {
  const wanted = prefix.toLowerCase()
  if (wanted === running.command?.toLowerCase()) return running.provider
  const providers = [...new Set(held.map(({ provider }) => provider))]
  return providers.includes(wanted)
    ? wanted
    : fail(`${prefix} is not a messenger in the store — it holds ${providers.join(", ") || "no accounts yet"}`)
}

const accountOf = (provider: Provider, ref: string, context: ListContext): AccountKey => {
  const ofProvider = context.held.filter((one) => one.provider === provider)
  const byId = ofProvider.find(({ account }) => account === ref || account === ref.toLowerCase())
  if (byId) return { provider, account: byId.account }
  if (provider === context.running.provider) {
    const id = context.profile?.(ref)
    if (id !== undefined) return { provider, account: id }
  }
  const byName = ofProvider.filter(({ name }) => name?.toLowerCase() === ref.toLowerCase())
  if (byName.length === 1) return { provider, account: (byName[0] as StoredAccount).account }
  if (byName.length > 1) fail(`${provider}:${ref} names ${byName.length} accounts — use the id: ${describe(byName)}`)
  const profiles = provider === context.running.provider ? (context.profiles?.() ?? []) : []
  return fail(
    `no ${provider} account "${ref}" — the store holds ${describe(ofProvider) || "none"}` +
      (profiles.length ? `; profiles here: ${profiles.join(", ")}` : ""),
  )
}

/**
 * The accounts `--source group:work,tg:tg3,max:Alice,email` names, in order and once each. An entry is a
 * group, `messenger:account` — the account's id, its name, or a profile of the app running — or a bare
 * `--source` word for every account it covers.
 */
export const accountsOfList = (value: string, context: ListContext): AccountKey[] => {
  const chosen = new Map<string, AccountKey>()
  const add = (key: AccountKey) => chosen.set(`${key.provider}\u0000${key.account}`, key)
  const sources: Source[] = [...new Set(context.held.map(({ provider }) => provider)), "personal", "bots", "all"]
  const entry = (item: string, group?: string) => {
    const colon = item.indexOf(":")
    if (colon === -1) {
      const source = item.toLowerCase() === context.running.command?.toLowerCase() ? context.running.provider : item
      if (!sources.includes(source.toLowerCase()))
        fail(
          `"${item}"${group ? ` in group ${group}` : ""} is none of ${sources.join(", ")}, group:<name> or messenger:account`,
        )
      for (const one of context.held) if (inSource(source.toLowerCase(), one.provider)) add(one)
      return
    }
    const prefix = item.slice(0, colon)
    const ref = item.slice(colon + 1).trim()
    if (ref === "") fail(`"${item}" names no account after the colon`)
    if (prefix.toLowerCase() === "group") {
      if (group) fail(`group ${group} lists another group — a group lists accounts`)
      const members = context.groups[ref]
      if (!members) {
        const known = Object.keys(context.groups)
        fail(
          `no account group "${ref}" — ${known.length ? `there are ${known.join(", ")}` : "none saved yet"}; ` +
            `\`config set ${ACCOUNT_GROUPS}.${ref} <accounts>\` saves one`,
        )
      }
      for (const member of members as string[]) entry(member, ref)
      return
    }
    add(accountOf(providerOf(prefix, context), ref, context))
  }
  for (const item of itemsOf(value)) entry(item)
  return [...chosen.values()]
}
