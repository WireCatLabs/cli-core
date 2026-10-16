import { CliError, type ErrorCode } from "@wirecat/cli-base"
import type { Provider } from "../domain/models.js"
import {
  FOLDER_PROVIDER,
  INTERNAL_NOTES,
  isKind,
  type Kind,
  kindOf,
  PROVIDERS,
  providerNamed,
} from "../domain/providers.js"
import type { AccountKey, StoredAccount } from "../store/store.js"
import { isBotProvider } from "./query.js"

/** Store-wide: every profile, tg, MAX and memo reads the same groups. */
export const ACCOUNT_GROUPS = "accountGroups"

/** The name `config` takes and shows; the store key above keeps its older spelling so no store migrates. */
export const ACCOUNT_GROUPS_SETTING = "account_groups"

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

/** What `config set account_groups.<name>` saves: the entries as written, so each app resolves its own profiles. */
export const groupMembers = (value: string): string[] =>
  itemsOf(value).map((item) =>
    item.toLowerCase().startsWith("group:")
      ? fail(`a group lists accounts, not other groups — "${item}"`)
      : item.includes(":") && item.split(":")[1] === ""
        ? fail(`"${item}" names no account after the colon`)
        : item,
  )

const describe = (accounts: readonly Held[]) =>
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

/** An account as `--source` and a hit name it: a notes folder is `notes:<its id>`, never the store's ulid. */
export interface ListedAccount extends AccountKey {
  kind: Kind
}

/** One entry of the list as written, a group's member included, and the accounts it named. */
export interface ListedEntry {
  entry: string
  accounts: ListedAccount[]
}

type Held = ListedAccount & { name: string | null }

const heldOf = (stored: readonly StoredAccount[]): Held[] => [
  ...stored
    .filter(({ provider }) => kindOf(provider) !== "notes")
    .map(({ provider, account, name }) => ({ provider, account, name, kind: kindOf(provider) })),
  { provider: "notes", account: INTERNAL_NOTES, name: null, kind: "notes" },
  ...stored
    .filter(({ provider }) => provider === FOLDER_PROVIDER)
    .map(({ id, name }) => ({ provider: "notes", account: String(id), name, kind: "notes" as const })),
]

const registry = () =>
  PROVIDERS.map(({ name, aliases }) => (aliases.length ? `${name} (${aliases.join(", ")})` : name)).join(", ")

const providerOf = (prefix: string, held: readonly Held[], { running, profiles }: ListContext): Provider => {
  const wanted = prefix.toLowerCase()
  if (wanted === running.command?.toLowerCase()) return running.provider
  const providers = [...new Set(held.map(({ provider }) => provider))]
  if (providers.includes(wanted)) return wanted
  const named = providerNamed(wanted)
  if (named) return named.name
  const recorded = Object.values(profiles[wanted] ?? {})[0]
  if (recorded) return recorded.provider
  return fail(`${prefix} is not a provider — they are ${registry()}; the store holds ${providers.join(", ")}`)
}

const profilesOf = (provider: Provider, profiles: Profiles): [string, AccountKey][] =>
  Object.values(profiles).flatMap((named) => Object.entries(named).filter(([, key]) => key.provider === provider))

const accountOf = (prefix: string, ref: string, held: readonly Held[], context: ListContext): Held => {
  const provider = providerOf(prefix, held, context)
  const ofProvider = held.filter((one) => one.provider === provider)
  const byId = ofProvider.find(({ account }) => account === ref || account === ref.toLowerCase())
  if (byId) return byId
  const keyed = (key: AccountKey): Held =>
    ofProvider.find(({ account }) => account === key.account) ?? { ...key, name: null, kind: kindOf(key.provider) }
  const recorded = context.profiles[prefix.toLowerCase()]?.[ref]
  if (recorded?.provider === FOLDER_PROVIDER) {
    const folder = held.find((one) => one.provider === "notes" && one.name === recorded.account)
    if (folder) return folder
    return fail(`no stored folder for ${prefix}:${ref}; sync that profile first`)
  }
  if (recorded) return keyed(recorded)
  const byProfile = [
    ...new Map(
      profilesOf(provider, context.profiles)
        .filter(([name]) => name === ref)
        .map(([, key]) => [key.account, key]),
    ).values(),
  ]
  if (byProfile.length === 1) return keyed(byProfile[0] as AccountKey)
  const byName = ofProvider.filter(({ name }) => name?.toLowerCase() === ref.toLowerCase())
  if (byName.length === 1) return byName[0] as Held
  if (byName.length > 1 || byProfile.length > 1)
    fail(`${provider}:${ref} names more than one account — use the id: ${describe(ofProvider)}`)
  const names = profilesOf(provider, context.profiles).map(([name]) => name)
  return fail(
    `no ${provider} account "${ref}" — the store holds ${describe(ofProvider) || "none"}` +
      (names.length ? `; profiles: ${[...new Set(names)].join(", ")}` : ""),
  )
}

/** `all`, `personal` and `bots` are groups no one saves; a kind or a provider names all its accounts. */
const accountsOfWord = (word: string, held: readonly Held[], context: ListContext): Held[] => {
  const wanted = word.toLowerCase()
  if (wanted === "all") return [...held]
  if (wanted === "personal" || wanted === "bots")
    return held.filter(({ provider, kind }) => kind === "messages" && isBotProvider(provider) === (wanted === "bots"))
  if (isKind(wanted)) return held.filter(({ kind }) => kind === wanted)
  const recorded = context.profiles[wanted]
  if (recorded && Object.values(recorded).every((key) => key.provider === FOLDER_PROVIDER))
    return Object.keys(recorded).map((profile) => accountOf(word, profile, held, context))
  const provider = providerOf(word, held, context)
  return held.filter((one) => one.provider === provider)
}

const keyOf = ({ provider, account }: AccountKey) => `${provider}\u0000${account}`

/**
 * What `--source group:work,tg:tg3,max:Alice,email,notes:4` names, entry by entry, a group's members in its
 * place. An entry is a group, `provider:account` — the account's id, a profile of any app that recorded it, or
 * the account's name — a bare provider for all its accounts, or a bare kind for every provider of it.
 */
export const entriesOfList = (value: string, context: ListContext): ListedEntry[] => {
  const held = heldOf(context.held)
  const entries: ListedEntry[] = []
  const entry = (item: string, group?: string) => {
    const colon = item.indexOf(":")
    if (colon === -1) {
      try {
        entries.push({ entry: item, accounts: accountsOfWord(item, held, context) })
      } catch (error) {
        if (!group || !(error instanceof CliError)) throw error
        fail(`"${item}" in group ${group}: ${error.message}`)
      }
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
            `\`config set ${ACCOUNT_GROUPS_SETTING}.${ref} <accounts>\` saves one`,
        )
      }
      for (const member of members as string[]) entry(member, ref)
      return
    }
    entries.push({ entry: item, accounts: [accountOf(prefix, ref, held, context)] })
  }
  for (const item of itemsOf(value)) entry(item)
  return entries.map(({ entry, accounts }) => ({
    entry,
    accounts: accounts.map(({ provider, account, kind }) => ({ provider, account, kind })),
  }))
}

/** Every account the list names, in order and once each. */
export const accountsOfList = (value: string, context: ListContext): ListedAccount[] => {
  const chosen = new Map<string, ListedAccount>()
  for (const { accounts } of entriesOfList(value, context))
    for (const one of accounts) if (!chosen.has(keyOf(one))) chosen.set(keyOf(one), one)
  return [...chosen.values()]
}

export interface SkippedSource {
  source: string
  /** The answer's `meta.issues` code: the entry holds no account, or none of the kinds this command reads. */
  code: Extract<ErrorCode, "not_found" | "validation_error">
  reason: string
}

const READS: Record<Kind, string> = {
  messages: "messenger messages — search messages reads them",
  mail: "a mailbox — memo search mail reads it",
  notes: "notes — search notes reads them",
  documents: "documents — search notes reads them",
  meetings: "meetings — search all reads them",
}

/**
 * The accounts of `kinds` the entries name, and each entry that names none of them with the reason. A search
 * fails only when nothing fits: `what` names the search in that error.
 */
export const fitting = (
  entries: readonly ListedEntry[],
  kinds: readonly Kind[],
  what: string,
  reasonOf: (kind: Kind) => string = (kind) => READS[kind],
): { accounts: AccountKey[]; skipped: SkippedSource[] } => {
  const chosen = new Map<string, AccountKey>()
  const skipped: SkippedSource[] = []
  for (const { entry, accounts } of entries) {
    const fits = accounts.filter(({ kind }) => kinds.includes(kind))
    for (const { provider, account } of fits)
      if (!chosen.has(keyOf({ provider, account }))) chosen.set(keyOf({ provider, account }), { provider, account })
    if (fits.length) continue
    const other = accounts[0]
    skipped.push(
      other
        ? { source: entry, code: "validation_error", reason: reasonOf(other.kind) }
        : { source: entry, code: "not_found", reason: "no account in the store" },
    )
  }
  if (chosen.size === 0)
    fail(
      `--source names nothing ${what} reads: ${skipped.map(({ source, reason }) => `${source} (${reason})`).join(", ")}`,
    )
  return { accounts: [...chosen.values()], skipped }
}
