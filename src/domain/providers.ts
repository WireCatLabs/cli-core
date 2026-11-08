import { CliError } from "@wirecat/cli-base"
import type { Provider } from "./models.js"
import { REF_KINDS, type RefKindName } from "./references.js"

/** What a search reads; the same names `--only`, `searched` and `skipped` use. */
export const KINDS = ["messages", "mail", "notes", "documents", "meetings", "events", "crm"] as const
export type Kind = (typeof KINDS)[number]

export interface ProviderEntry {
  name: Provider
  /** The first of `kinds`: what a build that knows one kind per provider reads. */
  kind: Kind
  /**
   * Every kind its accounts hold, `kind` first: one phone account holds SMS and calls, so an account group naming it
   * once reaches both. Left out, `[kind]`.
   */
  kinds?: readonly Kind[]
  aliases: readonly string[]
  /** The CLI that wrote the entry (`zm`, `drive`). One CLI may write several providers, so it is not an alias. */
  command?: string
  /** The read command, after `<command> <profile>`, that opens a ref of each kind: `{ chat: "messages list" }`. */
  opens?: Partial<Record<RefKindName, string>>
}

const MESSENGER_OPENS = { chat: "messages list", message: "messages show", contact: "contacts show" } as const
/** What a CRM CLI's entry gives as `opens`: the read commands `addCrmCommands` mounts. */
export const CRM_OPENS = { deal: "deals show", lead: "leads show", pipeline: "pipelines show" } as const

/** The seed: what cli-core knows before any CLI has written its entry into the store. */
export const PROVIDERS: readonly ProviderEntry[] = [
  { name: "telegram", kind: "messages", aliases: ["tg"], command: "tg", opens: MESSENGER_OPENS },
  { name: "telegram-bot", kind: "messages", aliases: ["tg-bot"] },
  { name: "max", kind: "messages", aliases: [], command: "max", opens: MESSENGER_OPENS },
  { name: "max-bot", kind: "messages", aliases: [] },
  { name: "whatsapp", kind: "messages", aliases: ["wa"], command: "wa", opens: MESSENGER_OPENS },
  { name: "whatsapp-bot", kind: "messages", aliases: ["wa-bot"] },
  { name: "email", kind: "mail", aliases: [] },
  { name: "notes", kind: "notes", aliases: [] },
  { name: "local", kind: "notes", aliases: [] },
  { name: "obsidian", kind: "notes", aliases: [] },
  { name: "added", kind: "notes", aliases: [] },
  { name: "zoom", kind: "meetings", aliases: [] },
  // A phone export's records: its SMS and its calls in the one account the import names.
  { name: "phone", kind: "messages", kinds: ["messages", "events"], aliases: [] },
]

const LABELS: Readonly<Record<string, string>> = {
  telegram: "Telegram",
  "telegram-bot": "Telegram bot",
  max: "MAX",
  "max-bot": "MAX bot",
  whatsapp: "WhatsApp",
  "whatsapp-bot": "WhatsApp bot",
  "google-drive": "Google Drive",
  added: "added by hand",
  email: "mail",
}

/** How a text names a provider to a person: `MAX`, not `max`. */
export const providerLabel = (provider: Provider): string => LABELS[provider] ?? provider

/**
 * A notes folder is an `accounts` row of one of these providers; people call every one `notes`. `obsidian` is a vault,
 * `local` a plain folder (store version 32). `folder` is what they were before, and what Drive's stand-in folders and
 * profile keys saved before that still say.
 */
export const FOLDER_PROVIDERS = ["local", "obsidian", "folder"] as const
export const isFolderProvider = (provider: string): boolean =>
  (FOLDER_PROVIDERS as readonly string[]).includes(provider)
/** The same test in SQL, over an `accounts` row's `provider` column. */
export const folderProviderSql = (column = "provider"): string =>
  `${column} IN (${FOLDER_PROVIDERS.map((name) => `'${name}'`).join(", ")})`
/** The provider a new folder of this format gets. */
export const folderProviderOf = (format: "obsidian" | "markdown"): "obsidian" | "local" =>
  format === "markdown" ? "local" : "obsidian"
/**
 * Providers whose account holds documents the way a notes folder does: one account per remote principal, its
 * files as `documents` rows (store version 31 moved Drive here from a `folder` named `google-drive:<principal>`).
 * The provider registry's `documents` kind replaces this list when Drive leaves `notes` (Wave 3 R2).
 */
export const DOCUMENT_ACCOUNT_PROVIDERS = ["google-drive"] as const
export const isDocumentAccountProvider = (provider: string): boolean =>
  (DOCUMENT_ACCOUNT_PROVIDERS as readonly string[]).includes(provider)
/**
 * What the owner adds by hand (`saveAddedSource`): one account, `owner`. Neither a folder nor a documents account, so no
 * folder can be bound to it and no sync deletes a source whose file is gone.
 */
export const ADDED_PROVIDER = "added"
export const ADDED_ACCOUNT = "owner"
/** Documents `d` outside the added sources: a folder file joined to one would delete it when the file goes. */
export const notAdded = `d.account_id NOT IN (SELECT id FROM accounts WHERE provider = '${ADDED_PROVIDER}')`
/** A folder, a documents account or the added sources, in SQL over an `accounts` row's `provider` column. */
export const filesAccountSql = (column = "provider"): string =>
  `${column} IN (${[...FOLDER_PROVIDERS, ...DOCUMENT_ACCOUNT_PROVIDERS, ADDED_PROVIDER].map((name) => `'${name}'`).join(", ")})`
/** Notes written in memo have no account row; this is their account. */
export const INTERNAL_NOTES = "internal"

/** The reason a search gives for an account whose provider no entry names. */
export const UNKNOWN_PROVIDER = "unknown provider — run its CLI once"

const WORD = /^[a-z0-9][a-z0-9_-]*$/

const invalid = (message: string): never => {
  throw new CliError("validation_error", message)
}

const wordOf = (value: unknown, what: string): string =>
  typeof value === "string" && WORD.test(value)
    ? value
    : invalid(`${what} is lowercase letters, digits, - and _ — not ${JSON.stringify(value)}`)

const OPEN_KINDS = new Set<string>(REF_KINDS.map(({ type }) => type).filter((type) => type !== "entity"))
const COMMAND_WORDS = /^[a-z0-9][a-z0-9_-]*( [a-z0-9][a-z0-9_-]*)*$/

/** A kind this build does not know is dropped, not refused: a newer CLI may open kinds added after this release. */
const opensOf = (value: unknown, named: string): Partial<Record<RefKindName, string>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid(`provider ${named}'s opens maps a kind of reference to a command`)
  const known = Object.entries(value).filter(([kind]) => OPEN_KINDS.has(kind))
  for (const [kind, command] of known)
    if (typeof command !== "string" || !COMMAND_WORDS.test(command))
      invalid(`provider ${named} opens a ${kind} with command words, not ${JSON.stringify(command)}`)
  return Object.fromEntries(known)
}

/** An entry as a CLI or the store gives it, checked: anything else is a `validation_error`. */
export const providerEntryOf = (value: unknown): ProviderEntry => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid("a provider entry is an object")
  const { name, kind, kinds, aliases = [], command, opens } = value as Record<string, unknown>
  const named = wordOf(name, "a provider's name")
  const isKindWord = (one: unknown): one is Kind =>
    typeof one === "string" && (KINDS as readonly string[]).includes(one)
  const given = kinds === undefined ? [kind] : Array.isArray(kinds) && kinds.length > 0 ? kinds : [undefined]
  for (const one of given)
    if (!isKindWord(one)) invalid(`provider ${named}'s kind is one of ${KINDS.join(", ")} — not ${JSON.stringify(one)}`)
  const list = [...new Set(given as Kind[])]
  if (kind !== undefined && kind !== list[0]) invalid(`provider ${named}'s kind is the first of its kinds`)
  if (!Array.isArray(aliases)) invalid(`provider ${named}'s aliases are a list`)
  return {
    name: named,
    kind: list[0] as Kind,
    ...(list.length > 1 ? { kinds: list } : {}),
    aliases: [...new Set((aliases as unknown[]).map((alias) => wordOf(alias, `an alias of ${named}`)))],
    ...(command === undefined ? {} : { command: wordOf(command, `the command of ${named}`) }),
    ...(opens === undefined ? {} : { opens: opensOf(opens, named) }),
  }
}

export const kindsOfEntry = (entry: Pick<ProviderEntry, "kind" | "kinds">): readonly Kind[] =>
  entry.kinds ?? [entry.kind]

const describe = (entry: ProviderEntry) =>
  `${entry.name} (${kindsOfEntry(entry).join(", ")}${entry.command ? `, from ${entry.command}` : ""})`

/** One list of kinds holding the other, both led by the same kind: an older build writes that first one only. */
const widerKinds = (a: readonly Kind[], b: readonly Kind[]): readonly Kind[] | undefined =>
  b.every((one) => a.includes(one)) ? a : a.every((one) => b.includes(one)) ? b : undefined

const wordsOf = ({ name, aliases }: ProviderEntry) => [name, ...aliases]

/** `entry` joined to `known`: the same name keeps one entry with both entries' aliases; a clash is an error. */
const joined = (known: readonly ProviderEntry[], entry: ProviderEntry): ProviderEntry[] => {
  const same = known.find(({ name }) => name === entry.name)
  const kinds = same ? widerKinds(kindsOfEntry(same), kindsOfEntry(entry)) : kindsOfEntry(entry)
  if (same && (kinds === undefined || same.kind !== entry.kind))
    invalid(`two provider entries disagree on the kind: ${describe(same)} and ${describe(entry)}`)
  const merged: ProviderEntry = same
    ? {
        ...same,
        ...(kinds && kinds.length > 1 ? { kinds } : {}),
        aliases: [...new Set([...same.aliases, ...entry.aliases])],
        ...(entry.command ? { command: entry.command } : {}),
        ...(entry.opens ? { opens: { ...same.opens, ...entry.opens } } : {}),
      }
    : entry
  const others = known.filter((one) => one !== same)
  for (const word of wordsOf(merged)) {
    const owner = others.find((one) => wordsOf(one).includes(word))
    if (owner) invalid(`"${word}" names two providers: ${describe(owner)} and ${describe(merged)}`)
  }
  return same ? known.map((one) => (one === same ? merged : one)) : [...known, merged]
}

let registry: readonly ProviderEntry[] = PROVIDERS

/** The built-ins and the entries the store or the CLI running gave; what `kindOf` and `providerNamed` read. */
export const providers = (): readonly ProviderEntry[] => registry

/**
 * Replaces the entries beyond the built-ins. Opening the store calls it with the stored entries; a test or a CLI
 * with no store may call it too. Two entries that disagree on a kind, or one word naming two providers, throw.
 */
export const useProviders = (entries: readonly ProviderEntry[]): void => {
  registry = entries.map(providerEntryOf).reduce(joined, PROVIDERS)
}

/**
 * Like `useProviders`, but an entry that clashes is left out instead of failing: what the store holds was written
 * by CLIs of other versions, and one stale entry must not stop the store opening. Answers the entries left out.
 */
export const useStoredProviders = (entries: readonly unknown[]): unknown[] => {
  const left: unknown[] = []
  registry = entries.reduce<readonly ProviderEntry[]>((known, entry) => {
    try {
      return joined(known, providerEntryOf(entry))
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      left.push(entry)
      return known
    }
  }, PROVIDERS)
  return left
}

/** Adds one entry to those in use, strictly: a clash throws and leaves the registry as it was. */
export const addProvider = (entry: ProviderEntry): void => {
  registry = joined(registry, providerEntryOf(entry))
}

export const isKind = (word: string): word is Kind => (KINDS as readonly string[]).includes(word.toLowerCase())

/** The registry's provider a name or alias stands for. */
export const providerNamed = (word: string): ProviderEntry | undefined => {
  const wanted = word.toLowerCase()
  return registry.find((entry) => wordsOf(entry).includes(wanted))
}

/** The kind of a provider the registry knows; `undefined` for one no entry names, which a search skips. */
export const kindIn = (provider: Provider): Kind | undefined =>
  isFolderProvider(provider) ? "notes" : registry.find(({ name }) => name === provider)?.kind

/** Every kind a provider's accounts hold, its `kind` first; empty for one no entry names. */
export const kindsIn = (provider: Provider): readonly Kind[] => {
  if (isFolderProvider(provider)) return ["notes"]
  const entry = registry.find(({ name }) => name === provider)
  return entry ? kindsOfEntry(entry) : []
}

/** Whether a provider's accounts hold `kind`: what a search lane picks its accounts by. */
export const holdsKind = (provider: Provider, kind: Kind): boolean => kindsIn(provider).includes(kind)

/** `holdsKind`, with a provider no entry names counted as a messenger, as `kindOf` counts it. */
export const holdsKindOf = (provider: Provider, kind: Kind): boolean =>
  kindIn(provider) === undefined ? kind === "messages" : holdsKind(provider, kind)

/** A provider the registry does not list counts as a messenger here; a search asks `kindIn` and skips it. */
export const kindOf = (provider: Provider): Kind => kindIn(provider) ?? "messages"
