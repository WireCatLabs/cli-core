import { CliError } from "@wirecat/cli-base"
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

/** Per app command (`tg`, `max`), each profile's account, as the app recorded it on its first save. */
export type Profiles = Record<string, Record<string, AccountKey>>

export interface ListContext {
  held: readonly StoredAccount[]
  groups: AccountGroups
  profiles: Profiles
  /** The provider of the app running, and the command people call it by (`tg` for telegram). */
  running: { provider: Provider; command?: string }
}

const providerOf = (prefix: string, { held, running, profiles }: ListContext): Provider => {
  const wanted = prefix.toLowerCase()
  if (wanted === running.command?.toLowerCase()) return running.provider
  const recorded = Object.values(profiles[wanted] ?? {})[0]
  if (recorded) return recorded.provider
  const providers = [...new Set(held.map(({ provider }) => provider))]
  return providers.includes(wanted)
    ? wanted
    : fail(`${prefix} is not a messenger in the store — it holds ${providers.join(", ") || "no accounts yet"}`)
}

const profilesOf = (provider: Provider, profiles: Profiles): [string, AccountKey][] =>
  Object.values(profiles).flatMap((named) => Object.entries(named).filter(([, key]) => key.provider === provider))

const accountOf = (prefix: string, ref: string, context: ListContext): AccountKey => {
  const provider = providerOf(prefix, context)
  const ofProvider = context.held.filter((one) => one.provider === provider)
  const byId = ofProvider.find(({ account }) => account === ref || account === ref.toLowerCase())
  if (byId) return { provider, account: byId.account }
  const recorded = context.profiles[prefix.toLowerCase()]?.[ref]
  if (recorded) return recorded
  const byProfile = [
    ...new Map(
      profilesOf(provider, context.profiles)
        .filter(([name]) => name === ref)
        .map(([, key]) => [key.account, key]),
    ).values(),
  ]
  if (byProfile.length === 1) return byProfile[0] as AccountKey
  const byName = ofProvider.filter(({ name }) => name?.toLowerCase() === ref.toLowerCase())
  if (byName.length === 1) return { provider, account: (byName[0] as StoredAccount).account }
  if (byName.length > 1 || byProfile.length > 1)
    fail(`${provider}:${ref} names more than one account — use the id: ${describe(ofProvider)}`)
  const names = profilesOf(provider, context.profiles).map(([name]) => name)
  return fail(
    `no ${provider} account "${ref}" — the store holds ${describe(ofProvider) || "none"}` +
      (names.length ? `; profiles: ${[...new Set(names)].join(", ")}` : ""),
  )
}

/**
 * The accounts `--source group:work,tg:tg3,max:Alice,email` names, in order and once each. An entry is a
 * group, `messenger:account` — the account's id, a profile of any app that recorded it, or the account's name —
 * or a bare `--source` word for every account it covers.
 */
export const accountsOfList = (value: string, context: ListContext): AccountKey[] => {
  const chosen = new Map<string, AccountKey>()
  const add = (key: AccountKey) => chosen.set(`${key.provider}\u0000${key.account}`, key)
  const sources: Source[] = [...new Set(context.held.map(({ provider }) => provider)), "personal", "bots", "all"]
  const entry = (item: string, group?: string) => {
    const colon = item.indexOf(":")
    if (colon === -1) {
      const app = item.toLowerCase()
      const source =
        app === context.running.command?.toLowerCase()
          ? context.running.provider
          : (Object.values(context.profiles[app] ?? {})[0]?.provider ?? item)
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
    add(accountOf(prefix, ref, context))
  }
  for (const item of itemsOf(value)) entry(item)
  return [...chosen.values()]
}
